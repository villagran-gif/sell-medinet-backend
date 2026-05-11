import { Router } from "express";
import { requireBearer } from "../lib/auth.js";
import { tick } from "../scheduler.js";

const router = Router();

/**
 * POST /confirmations/tick
 *
 * Una pasada del scheduler: envía 1er mensajes pendientes + recordatorios
 * T-76h. Diseñado para ser invocado por un cron externo (Render Cron,
 * GitHub Actions, cron del VPS) cada 5–15 minutos.
 *
 * Auth: Bearer CONFIRMATIONS_INTAKE_TOKEN.
 *
 * Query params:
 *   firstLimit   default 20
 *   reminderLimit default 50
 */
router.post("/", requireBearer, async (req, res) => {
  const firstLimit = clampLimit(req.query.firstLimit, 20, 500);
  const reminderLimit = clampLimit(req.query.reminderLimit, 50, 500);

  try {
    const summary = await tick({
      firstMsgLimit: firstLimit,
      reminderLimit,
    });
    return res.status(200).json({ status: "ok", ...summary });
  } catch (err) {
    console.error("[confirmations/tick] failed:", err.message);
    return res.status(500).json({ error: "tick_failed", message: err.message });
  }
});

function clampLimit(raw, def, max) {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}

export default router;
