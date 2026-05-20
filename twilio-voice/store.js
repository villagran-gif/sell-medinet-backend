import { getPool } from "./db.js";

// Persistencia de eventos de Twilio. Todo es best-effort desde las rutas:
// si la DB falla, la llamada NO se cae (ver routes/voice.js::safe()).

export async function persistRawEvent({ eventType, callSid, payload, sigVerified }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO twilio_voice.raw_events (event_type, call_sid, payload, sig_verified)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [eventType, callSid || null, payload, !!sigVerified]
  );
  return rows[0].id;
}

export async function upsertCallIncoming({
  callSid,
  from,
  to,
  agentDialed,
  chatwootSourceId,
  chatwootConversationId,
}) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO twilio_voice.calls
       (call_sid, from_number, to_number, agent_dialed, status,
        chatwoot_source_id, chatwoot_conversation_id, started_at)
     VALUES ($1, $2, $3, $4, 'incoming', $5, $6, now())
     ON CONFLICT (call_sid) DO UPDATE SET
       from_number              = EXCLUDED.from_number,
       to_number                = EXCLUDED.to_number,
       agent_dialed             = EXCLUDED.agent_dialed,
       chatwoot_source_id       = COALESCE(twilio_voice.calls.chatwoot_source_id, EXCLUDED.chatwoot_source_id),
       chatwoot_conversation_id = COALESCE(twilio_voice.calls.chatwoot_conversation_id, EXCLUDED.chatwoot_conversation_id)`,
    [
      callSid,
      from || null,
      to || null,
      agentDialed || null,
      chatwootSourceId || null,
      chatwootConversationId || null,
    ]
  );
}

export async function updateDialResult({ callSid, dialStatus, durationSeconds }) {
  const pool = getPool();
  await pool.query(
    `UPDATE twilio_voice.calls
       SET dial_status      = $2,
           duration_seconds = COALESCE($3, duration_seconds),
           status           = CASE WHEN $2 = 'completed' THEN 'answered' ELSE 'missed' END,
           ended_at         = now()
     WHERE call_sid = $1`,
    [callSid, dialStatus || null, durationSeconds ?? null]
  );
}

export async function updateVoicemail({ callSid, recordingUrl, recordingSeconds }) {
  const pool = getPool();
  await pool.query(
    `UPDATE twilio_voice.calls
       SET recording_url     = $2,
           recording_seconds = $3,
           status            = 'voicemail',
           ended_at          = now()
     WHERE call_sid = $1`,
    [callSid, recordingUrl || null, recordingSeconds ?? null]
  );
}

export async function getCall(callSid) {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT * FROM twilio_voice.calls WHERE call_sid = $1",
    [callSid]
  );
  return rows[0] || null;
}
