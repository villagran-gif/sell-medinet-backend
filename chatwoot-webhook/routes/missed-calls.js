import { Router } from "express";
import { getPool } from "../db.js";
import { followupNow } from "../missed-call/handler.js";

const router = Router();

// Disparo manual para una conversación de voz puntual (testing / backfill).
// POST /chatwoot-webhook/missed-calls/run
// body: { conversation_id }
router.post("/run", async (req, res) => {
  const { conversation_id } = req.body || {};
  if (!conversation_id) {
    return res.status(400).json({ ok: false, error: "missing conversation_id" });
  }
  try {
    const result = await followupNow(conversation_id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Status para una conversación específica.
router.get("/status/:conversation_id", async (req, res) => {
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, conversation_id, call_sid, customer_phone, customer_name,
              contact_id, followup_conversation_id, template_name, status,
              attempts, error, created_at, updated_at
         FROM chatwoot.missed_call_followups
        WHERE conversation_id = $1
        ORDER BY id DESC`,
      [Number(req.params.conversation_id)]
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Listado de los últimos N follow-ups (debug).
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT id, conversation_id, call_sid, customer_phone, customer_name,
              followup_conversation_id, status, attempts, error,
              created_at, updated_at
         FROM chatwoot.missed_call_followups
        ORDER BY id DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
