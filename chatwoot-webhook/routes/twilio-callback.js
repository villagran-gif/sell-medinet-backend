// Receiver del StatusCallback de Twilio.
//
// Twilio dispara POST acá cuando una llamada cambia de estado
// (ringing, in-progress, completed). Filtramos por CallStatus=completed
// para disparar la transcripción.
//
// Como el TwiML lo emite Chatwoot, este endpoint NO interfiere con el
// VoiceUrl. Se configura el StatusCallback a nivel del IncomingPhoneNumber
// (campo independiente que estaba vacío) — ver scripts/setup-twilio-status-callback.
//
// /voice-incoming: TwiML custom que reemplaza el Voice URL de Chatwoot.
// Saluda al caller, le avisa que recibirá WhatsApp, y cuelga. Sin música
// de espera. El polling sigue detectando la missed call vía Twilio API.

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

// POST /chatwoot-webhook/twilio/voice-incoming
// Configurar como Voice URL del número Twilio (reemplaza el de Chatwoot).
// Saluda + avisa WhatsApp + cuelga. Sin música. El StatusCallback queda
// en Chatwoot — Chatwoot Voice inbox sigue registrando la llamada.
router.post("/voice-incoming", (req, res) => {
  const callSid = req.body?.CallSid;
  const from = req.body?.From;
  console.log(`[twilio-voice] incoming ${callSid} from ${from}`);

  const message =
    process.env.TWILIO_VOICE_GREETING ||
    "Hola, gracias por llamar a Clínyco Centro Médico. En este momento no podemos atenderte por teléfono. Te enviaremos un mensaje por WhatsApp en unos minutos para coordinar tu atención. Hasta pronto.";
  const voice = process.env.TWILIO_VOICE_NAME || "Polly.Mia-Neural";
  const lang = process.env.TWILIO_VOICE_LANG || "es-MX";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${lang}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
  res.type("text/xml").send(twiml);
});

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
