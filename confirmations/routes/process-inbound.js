import { Router } from "express";
import { requireBearer } from "../lib/auth.js";
import { dispatchPending } from "../../chatwoot-dispatcher/index.js";

const router = Router();

/**
 * POST /confirmations/process-inbound?limit=50
 *
 * Procesa hasta `limit` mensajes pendientes de chatwoot.raw_events.
 * Idempotente — eventos ya procesados no se reprocesan (filtro
 * processed_at IS NULL).
 *
 * Pensado para que un cron externo lo dispare cada N segundos.
 * Devuelve un summary con conteos para observabilidad.
 *
 * Auth: Bearer CONFIRMATIONS_INTAKE_TOKEN.
 */
router.post("/", requireBearer, async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(500, Math.trunc(rawLimit)))
    : 50;

  try {
    const summary = await dispatchPending({ limit });
    return res.status(200).json({ status: "ok", ...summary });
  } catch (err) {
    console.error("[confirmations/process-inbound] failed:", err.message);
    return res.status(500).json({ error: "processor_failed", message: err.message });
  }
});

export default router;
