// Pipeline de transcripción de llamadas Chatwoot Voice.
//
// Disparo: fire-and-forget desde routes/events.js cuando llega un evento de
// cierre de conversación. El handler:
//
//  1. Lee la conversación desde la API de Chatwoot (para obtener call_sid + canal).
//  2. Si es Voice y tiene call_sid → upsert en chatwoot.call_transcriptions.
//  3. Busca la grabación en Twilio (espera 5s en el primer intento).
//  4. La descarga y la pasa por OpenAI Whisper.
//  5. Postea una nota privada en la conversación con la transcripción.
//
// Si la grabación todavía no está lista, deja el job en `pending` y lo
// retoma POST /webhooks/chatwoot/transcriptions/retry-pending (cron externo).

import { getPool } from "../db.js";
import { findRecordingByCallSid, downloadRecordingMp3 } from "../lib/twilio-recording.js";
import { transcribe } from "../lib/whisper.js";
import { getConversation, postPrivateNote } from "../lib/chatwoot-api.js";

const MAX_ATTEMPTS = 5;
const FIRST_ATTEMPT_WAIT_MS = 5000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isClosingEvent(payload) {
  if (payload?.event === "conversation_resolved") return true;
  if (payload?.event === "conversation_status_changed") {
    const s = payload.status || payload.conversation?.status;
    return s === "resolved" || s === "closed";
  }
  return false;
}

function extractConversationId(payload) {
  return (
    payload?.conversation?.id ||
    payload?.id ||
    payload?.conversation_id ||
    null
  );
}

function isVoiceChannel(conv) {
  const ct =
    conv?.meta?.channel ||
    conv?.inbox?.channel_type ||
    conv?.channel ||
    "";
  return String(ct).toLowerCase().includes("voice");
}

function extractCallSid(conv) {
  const aa =
    conv?.additional_attributes ||
    conv?.meta?.additional_attributes ||
    {};
  // Chatwoot suele guardar call_sid en additional_attributes. Probamos varios shapes.
  return (
    aa.call_sid ||
    aa.callSid ||
    aa.CallSid ||
    aa.twilio_call_sid ||
    aa.sid ||
    null
  );
}

// Entry point disparado por routes/events.js
export async function maybeTranscribe(payload) {
  if (process.env.CHATWOOT_TRANSCRIPTION_ENABLED !== "true") return;
  if (!isClosingEvent(payload)) return;

  const conversationId = extractConversationId(payload);
  if (!conversationId) return;

  try {
    await enqueueAndRun(conversationId);
  } catch (err) {
    console.error(`[transcription] failed for conv ${conversationId}:`, err.message);
  }
}

async function enqueueAndRun(conversationId) {
  const conv = await getConversation(conversationId);
  if (!isVoiceChannel(conv)) return;

  const callSid = extractCallSid(conv);
  if (!callSid) return;

  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO chatwoot.call_transcriptions
       (conversation_id, account_id, call_sid)
     VALUES ($1, $2, $3)
     ON CONFLICT (conversation_id, call_sid) DO UPDATE SET updated_at = now()
     RETURNING id, status`,
    [conversationId, conv?.account_id || null, callSid]
  );
  if (rows[0].status === "done") return;
  await runJob(rows[0].id);
}

async function runJob(id) {
  const pool = getPool();

  // Lock optimista: solo procesa si está pending/failed.
  const lock = await pool.query(
    `UPDATE chatwoot.call_transcriptions
       SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status IN ('pending','failed') AND attempts < $2
     RETURNING conversation_id, call_sid, attempts`,
    [id, MAX_ATTEMPTS]
  );
  if (lock.rows.length === 0) return;
  const { conversation_id, call_sid, attempts } = lock.rows[0];

  try {
    if (attempts === 1) await sleep(FIRST_ATTEMPT_WAIT_MS);

    const rec = await findRecordingByCallSid(call_sid);
    if (!rec) {
      await pool.query(
        `UPDATE chatwoot.call_transcriptions
           SET status = 'pending', error = 'recording not ready', updated_at = now()
         WHERE id = $1`,
        [id]
      );
      return;
    }

    const audio = await downloadRecordingMp3(rec.sid);
    const { text, model } = await transcribe(audio, { language: "es" });

    const dur = Number(rec.duration) || 0;
    const note =
      `🤖 *Transcripción de la llamada* (${dur}s)\n\n` +
      (text?.trim() || "_(audio sin contenido detectable)_");
    await postPrivateNote(conversation_id, note);

    await pool.query(
      `UPDATE chatwoot.call_transcriptions
         SET status = 'done',
             recording_sid = $2,
             recording_url = $3,
             duration_sec = $4,
             transcript = $5,
             language = 'es',
             whisper_model = $6,
             error = NULL,
             updated_at = now()
       WHERE id = $1`,
      [id, rec.sid, rec.uri || null, dur, text, model]
    );
  } catch (err) {
    await pool.query(
      `UPDATE chatwoot.call_transcriptions
         SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1`,
      [id, String(err.message || err).slice(0, 500)]
    );
    console.error(`[transcription] job ${id} failed:`, err.message);
  }
}

// Endpoint de retry para cron externo.
export async function retryPending({ limit = 10 } = {}) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id FROM chatwoot.call_transcriptions
      WHERE status IN ('pending','failed')
        AND attempts < $1
        AND updated_at < now() - interval '30 seconds'
      ORDER BY id
      LIMIT $2`,
    [MAX_ATTEMPTS, limit]
  );
  let processed = 0;
  for (const r of rows) {
    await runJob(r.id);
    processed++;
  }
  return { processed, found: rows.length };
}

// Disparo manual para tests (sin esperar webhook).
export async function transcribeNow({ conversation_id, call_sid }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO chatwoot.call_transcriptions
       (conversation_id, call_sid)
     VALUES ($1, $2)
     ON CONFLICT (conversation_id, call_sid) DO UPDATE
       SET status = CASE WHEN chatwoot.call_transcriptions.status = 'done'
                         THEN chatwoot.call_transcriptions.status
                         ELSE 'pending' END,
           updated_at = now()
     RETURNING id, status`,
    [conversation_id, call_sid]
  );
  if (rows[0].status === "done") return { id: rows[0].id, status: "done", note: "already done" };
  await runJob(rows[0].id);
  return { id: rows[0].id };
}
