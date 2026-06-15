import { Router } from "express";
import { getPool } from "../db.js";
import { retryPending, transcribeNow } from "../transcription/handler.js";

const router = Router();

// Cron externo: POST /webhooks/chatwoot/transcriptions/retry-pending?limit=10
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
// POST /webhooks/chatwoot/transcriptions/run
// body: { conversation_id, call_sid }
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

export default router;
