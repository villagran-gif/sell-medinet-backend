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
// Reemplaza el Voice URL de Chatwoot con un híbrido por horario:
//  - En horario laboral (L-V 9-18 Chile) → redirige a Chatwoot para que
//    agentes puedan contestar normalmente
//  - Fuera de horario → mensaje custom + cuelga, sin música
// El polling sigue detectando la missed call vía Twilio API en ambos casos.
router.post("/voice-incoming", (req, res) => {
  const callSid = req.body?.CallSid;
  const from = req.body?.From;
  const inHours = isBusinessHours();
  console.log(
    `[twilio-voice] incoming ${callSid} from ${from} businessHours=${inHours}`
  );
  res.type("text/xml").send(inHours ? buildRedirectTwiml() : buildHangupTwiml());
});

function buildRedirectTwiml() {
  const url =
    process.env.CHATWOOT_VOICE_URL ||
    "https://app.chatwoot.com/twilio/voice/call/56229148460";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">${escapeXml(url)}</Redirect>
</Response>`;
}

function buildHangupTwiml() {
  const message =
    process.env.TWILIO_VOICE_GREETING ||
    "Hola, gracias por llamar a Clínyco Centro Médico. Estamos disponibles de lunes a viernes de 9 a 18 horas. Te enviaremos un mensaje por WhatsApp en unos minutos para coordinar tu atención. Hasta pronto.";
  const voice = process.env.TWILIO_VOICE_NAME || "Polly.Mia-Neural";
  const lang = process.env.TWILIO_VOICE_LANG || "es-MX";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${lang}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

// Determina si la hora actual cae dentro del horario de atención
// configurado. Usa Intl en la zona horaria Chile para sortear DST.
function isBusinessHours() {
  const tz = process.env.TWILIO_VOICE_TZ || "America/Santiago";
  const hourStart = Number(process.env.TWILIO_VOICE_HOUR_START || 9);
  const hourEnd = Number(process.env.TWILIO_VOICE_HOUR_END || 18);
  const daysSpec = process.env.TWILIO_VOICE_BUSINESS_DAYS || "1,2,3,4,5";
  const businessDays = daysSpec.split(",").map((d) => Number(d.trim()));

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);

  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  if (!businessDays.includes(wmap[weekday])) return false;
  if (hour < hourStart || hour >= hourEnd) return false;
  return true;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
