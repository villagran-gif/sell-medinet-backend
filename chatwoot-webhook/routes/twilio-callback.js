// Receiver del StatusCallback de Twilio.
//
// Twilio dispara POST acá cuando una llamada cambia de estado
// (ringing, in-progress, completed). Filtramos por CallStatus=completed
// para disparar la transcripción.
//
// Como el TwiML lo emite Chatwoot, este endpoint NO interfiere con el
// VoiceUrl. Se configura el StatusCallback a nivel del IncomingPhoneNumber
// (campo independiente que estaba vacío) — ver scripts/setup-twilio-status-callback.

import { Router } from "express";
import express from "express";
import { transcribeByCallSid } from "../transcription/handler.js";

const router = Router();

// Twilio manda form-encoded, no JSON.
router.use(express.urlencoded({ extended: false }));

router.post("/call-status", (req, res) => {
  const body = req.body || {};
  const callSid = body.CallSid;
  const callStatus = body.CallStatus;
  const from = body.From;

  // Responder a Twilio inmediatamente — el procesamiento es background.
  res.json({ ok: true, received: callStatus });

  if (process.env.CHATWOOT_TRANSCRIPTION_ENABLED !== "true") return;
  if (callStatus !== "completed") return;
  if (!callSid || !from) return;

  // Background: esperar a que Twilio termine de finalizar la grabación
  // y luego matchear con Chatwoot.
  setTimeout(async () => {
    try {
      await transcribeByCallSid({ callSid, fromNumber: from });
      console.log(`[twilio-callback] transcribed ${callSid} from ${from}`);
    } catch (err) {
      console.error(`[twilio-callback] ${callSid} (${from}) failed:`, err.message);
    }
  }, 3000);
});

export default router;
