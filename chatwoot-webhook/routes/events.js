import { Router } from "express";
import express from "express";
import { getPool } from "../db.js";
import { verifyHmac } from "../lib/signature.js";

const router = Router();

/**
 * Auto-trigger del processor de confirmations apenas se persiste un
 * `message_created`. Esto baja la latencia del ack al paciente de
 * "0–2 minutos" (cron) a "2–5 segundos" (inline async).
 *
 * Implementación:
 * - Dynamic import para no acoplar chatwoot-webhook a confirmations
 *   en tiempo de carga (chatwoot-webhook puede usarse standalone).
 * - Fire-and-forget: no esperamos el resultado. El webhook responde
 *   200 inmediatamente; el processor corre en background.
 * - Errores se loguean pero no fallan el webhook.
 * - Opt-out con CHATWOOT_WEBHOOK_AUTOPROCESS=false.
 */
function autoProcessIfMessageCreated(eventType) {
  if (eventType !== "message_created") return;
  if (process.env.CHATWOOT_WEBHOOK_AUTOPROCESS === "false") return;

  // Fire-and-forget. limit pequeño para procesar lo que entró + algo
  // de catch-up, sin bloquear si hay backlog grande.
  import("../../confirmations/inbound-processor.js")
    .then(({ processInboundQueue }) => processInboundQueue({ limit: 10 }))
    .then((summary) => {
      if (summary.classified > 0 || summary.acked > 0) {
        console.log(
          `[chatwoot-webhook] autoprocess: classified=${summary.classified} ` +
            `matched=${summary.matched} acked=${summary.acked} skipped=${summary.skipped}`
        );
      }
    })
    .catch((err) => {
      console.error("[chatwoot-webhook] autoprocess failed:", err.message);
    });
}

// Parser JSON propio del módulo para capturar rawBody (necesario para HMAC).
// No sustituye al express.json() global de server.js — este solo aplica en /events.
router.use(
  express.json({
    limit: "512kb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

router.post("/", async (req, res) => {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  const requireSig = process.env.CHATWOOT_WEBHOOK_REQUIRE_SIG !== "false";

  const sigHeader =
    req.get("X-Chatwoot-Hmac-Signature") ||
    req.get("X-Hub-Signature-256") ||
    null;

  const sigOk = verifyHmac(req.rawBody, sigHeader, secret);

  if (requireSig && !sigOk) {
    return res.status(401).json({
      error: "invalid_or_missing_signature",
      hint: "set X-Chatwoot-Hmac-Signature header to 'sha256=<hex>' where hex = HMAC-SHA256(body, CHATWOOT_WEBHOOK_SECRET)",
    });
  }

  const payload = req.body || {};
  const eventType = payload.event || null;
  const accountId =
    payload.account?.id ?? payload.account_id ?? null;

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO chatwoot.raw_events (event_type, account_id, payload, sig_verified)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [eventType, accountId, payload, sigOk]
    );

    // Auto-trigger del processor para mensajes inbound. Background,
    // no esperamos el resultado — el webhook responde ya.
    autoProcessIfMessageCreated(eventType);

    return res.status(200).json({
      ok: true,
      event_id: rows[0].id,
      event_type: eventType,
    });
  } catch (err) {
    return res.status(500).json({
      error: "db_error",
      message: err.message,
    });
  }
});

export default router;
