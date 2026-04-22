import { Router } from "express";
import express from "express";
import { getPool } from "../db.js";
import { verifyHmac } from "../lib/signature.js";

const router = Router();

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
