import { Router } from "express";
import { getPool } from "../db.js";
import { chatwootEnabled } from "../lib/chatwoot.js";

const router = Router();

router.get("/", async (_req, res) => {
  const out = {
    status: "ok",
    module: "twilio-voice",
    mode: process.env.TWILIO_VOICE_FORWARD_TO ? "forward+voicemail" : "voicemail-only",
    chatwoot_enabled: chatwootEnabled(),
    signature_validation: process.env.TWILIO_VALIDATE_SIGNATURE !== "false",
    db: "unknown",
  };
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM twilio_voice.calls"
    );
    out.db = "ok";
    out.calls_count = rows[0].n;
  } catch (err) {
    out.db = "error";
    out.db_error = err.message;
  }
  res.json(out);
});

export default router;
