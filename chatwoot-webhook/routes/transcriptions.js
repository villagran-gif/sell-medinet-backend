import { Router } from "express";
import { getPool } from "../db.js";
import { retryPending, transcribeNow } from "../transcription/handler.js";

const router = Router();

// Cron externo: POST /chatwoot-webhook/transcriptions/retry-pending?limit=10
router.post("/retry-pending", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const result = await retryPending({ limit });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Disparo manual de transcripción para una llamada puntual (smoke test).
router.post("/run", async (req, res) => {
  const { conversation_id, call_sid } = req.body || {};
  if (!conversation_id || !call_sid) {
    return res.status(400).json({ ok: false, error: "missing conversation_id or call_sid" });
  }
  try {
    const result = await transcribeNow({
      conversation_id: Number(conversation_id),
      call_sid: String(call_sid),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Consulta de estado para una conversación.
router.get("/status/:conversation_id", async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, conversation_id, call_sid, recording_sid, duration_sec,
              status, attempts, language, whisper_model, error,
              left(transcript, 300) AS transcript_preview,
              created_at, updated_at
         FROM chatwoot.call_transcriptions
        WHERE conversation_id = $1
        ORDER BY id DESC`,
      [Number(req.params.conversation_id)]
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Listado de las últimas transcripciones (debug).
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, conversation_id, call_sid, recording_sid, duration_sec,
              status, attempts, error,
              left(transcript, 200) AS transcript_preview,
              created_at, updated_at
         FROM chatwoot.call_transcriptions
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Inspector de payloads de webhook (debug). Útil para ver shape real.
// GET /chatwoot-webhook/transcriptions/inspect-events?event=conversation_created&limit=3
router.get("/inspect-events", async (req, res) => {
  try {
    const eventType = String(req.query.event || "").trim();
    const limit = Math.min(Number(req.query.limit) || 5, 20);
    const pool = getPool();
    const params = [limit];
    let where = "1=1";
    if (eventType) {
      where = "event_type = $2";
      params.push(eventType);
    }
    const { rows } = await pool.query(
      `SELECT id, received_at, event_type,
              payload->'id' AS payload_id,
              payload->'display_id' AS payload_display_id,
              payload->'conversation'->'id' AS conv_id,
              payload->'conversation'->'display_id' AS conv_display_id,
              payload->'additional_attributes'->'call_sid' AS root_call_sid,
              payload->'conversation'->'additional_attributes'->'call_sid' AS conv_call_sid,
              payload->'channel' AS channel,
              payload->'inbox'->'channel_type' AS inbox_channel
         FROM chatwoot.raw_events
        WHERE ${where}
        ORDER BY id DESC
        LIMIT $1`,
      params
    );
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
