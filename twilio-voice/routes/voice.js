import { Router } from "express";
import express from "express";
import { validateTwilioSignature } from "../lib/signature.js";
import * as twiml from "../lib/twiml.js";
import * as store from "../store.js";
import * as chatwoot from "../lib/chatwoot.js";

const router = Router();

// Twilio postea application/x-www-form-urlencoded. Parser propio del módulo —
// no usamos el express.json() global de server.js para estas rutas (json()
// ignora este content-type y deja el stream intacto para urlencoded).
router.use(express.urlencoded({ extended: false }));

function lang() {
  return process.env.TWILIO_VOICE_LANGUAGE || "es-MX";
}
function maxVm() {
  return Number(process.env.TWILIO_VOICE_VOICEMAIL_MAXLEN || 120);
}

// Base pública del servicio para (1) validar la firma con la URL exacta que
// Twilio invocó y (2) construir URLs absolutas de callback en el TwiML.
// Detrás del proxy de Render, preferir TWILIO_VOICE_PUBLIC_BASE_URL.
function publicBase(req) {
  if (process.env.TWILIO_VOICE_PUBLIC_BASE_URL) {
    return process.env.TWILIO_VOICE_PUBLIC_BASE_URL.replace(/\/+$/, "");
  }
  const proto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("x-forwarded-host") || req.get("host");
  return `${proto}://${host}`;
}
function fullUrl(req) {
  return `${publicBase(req)}${req.originalUrl}`;
}
function cb(req, path) {
  return `${publicBase(req)}/twilio-voice${path}`;
}

function sendTwiml(res, xml) {
  res.status(200).type("text/xml").send(xml);
}

// Persistencia y Chatwoot son best-effort: NUNCA deben romper la respuesta
// TwiML. Si fallan, la llamada igual se atiende (solo se pierde el registro).
async function safe(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[twilio-voice] ${label} failed:`, err.message);
    return null;
  }
}

// Valida X-Twilio-Signature. Si la validación es obligatoria y falla,
// responde 403 con un TwiML de Hangup (no se filtra info). Para debugging
// inicial se puede apagar con TWILIO_VALIDATE_SIGNATURE=false.
function verifySignature(req, res, next) {
  const requireSig = process.env.TWILIO_VALIDATE_SIGNATURE !== "false";
  if (!requireSig) {
    req.twilioSigOk = false;
    return next();
  }
  const ok = validateTwilioSignature({
    authToken: process.env.TWILIO_AUTH_TOKEN,
    url: fullUrl(req),
    params: req.body,
    signature: req.get("X-Twilio-Signature"),
  });
  if (!ok) {
    return res.status(403).type("text/xml").send(twiml.response(twiml.hangup()));
  }
  req.twilioSigOk = true;
  return next();
}

function voicemailTwiml(req, prompt) {
  return twiml.response(
    twiml.say(prompt, { language: lang() }) +
      twiml.record({ action: cb(req, "/voicemail"), maxLength: maxVm() })
  );
}

// 1) Llamada entrante. Twilio pega acá al recibir la llamada al número.
router.post("/incoming", verifySignature, async (req, res) => {
  const b = req.body || {};
  const callSid = b.CallSid;
  const from = b.From;
  const to = b.To;
  const forwardTo = process.env.TWILIO_VOICE_FORWARD_TO;

  await safe("persist incoming", () =>
    store.persistRawEvent({
      eventType: "incoming",
      callSid,
      payload: b,
      sigVerified: req.twilioSigOk,
    })
  );

  // Crear contacto + conversación en Chatwoot y postear "llamada entrante".
  let sourceId = null;
  let conversationId = null;
  if (chatwoot.chatwootEnabled()) {
    const linked = await safe("chatwoot incoming", async () => {
      const c = await chatwoot.ensureContact({ phone: from, name: from });
      const conv = await chatwoot.createConversation({ sourceId: c.sourceId });
      await chatwoot.postMessage({
        sourceId: c.sourceId,
        conversationId: conv.conversationId,
        content: `📞 Llamada entrante de ${from || "desconocido"} al ${to || "número"}.`,
      });
      return { sourceId: c.sourceId, conversationId: conv.conversationId };
    });
    if (linked) {
      sourceId = linked.sourceId;
      conversationId = linked.conversationId;
    }
  }

  await safe("upsert call", () =>
    store.upsertCallIncoming({
      callSid,
      from,
      to,
      agentDialed: forwardTo || null,
      chatwootSourceId: sourceId,
      chatwootConversationId: conversationId,
    })
  );

  // Sin número de agente configurado → directo a buzón.
  if (!forwardTo) {
    const prompt =
      process.env.TWILIO_VOICE_VOICEMAIL_PROMPT ||
      "Gracias por llamar a Clínyco. En este momento no podemos atenderte. Por favor deja tu mensaje después del tono.";
    return sendTwiml(res, voicemailTwiml(req, prompt));
  }

  // Desviar al agente; el resultado del intento llega a /dial-status.
  const callerId = process.env.TWILIO_VOICE_CALLER_ID || to;
  return sendTwiml(
    res,
    twiml.response(
      twiml.dialNumber(forwardTo, {
        callerId,
        timeout: Number(process.env.TWILIO_VOICE_DIAL_TIMEOUT || 20),
        action: cb(req, "/dial-status"),
      })
    )
  );
});

// 2) Resultado del <Dial>. Si no se atendió → buzón. Si se atendió → fin.
router.post("/dial-status", verifySignature, async (req, res) => {
  const b = req.body || {};
  const callSid = b.CallSid;
  const dialStatus = b.DialCallStatus; // completed | no-answer | busy | failed | canceled
  const dialDuration = b.DialCallDuration ? Number(b.DialCallDuration) : null;

  await safe("persist dial-status", () =>
    store.persistRawEvent({
      eventType: "dial-status",
      callSid,
      payload: b,
      sigVerified: req.twilioSigOk,
    })
  );
  await safe("update dial result", () =>
    store.updateDialResult({ callSid, dialStatus, durationSeconds: dialDuration })
  );

  const answered = dialStatus === "completed";
  await safe("chatwoot dial-status", async () => {
    const call = await store.getCall(callSid);
    if (!call?.chatwoot_conversation_id || !call?.chatwoot_source_id) return;
    await chatwoot.postMessage({
      sourceId: call.chatwoot_source_id,
      conversationId: Number(call.chatwoot_conversation_id),
      content: answered
        ? `✅ Llamada atendida por el agente (${dialDuration ?? 0}s).`
        : `⚠️ Llamada no atendida (${dialStatus || "sin respuesta"}). Pasando a buzón de voz.`,
    });
  });

  if (answered) {
    return sendTwiml(res, twiml.response(twiml.hangup()));
  }

  const prompt =
    process.env.TWILIO_VOICE_VOICEMAIL_PROMPT ||
    "No pudimos atenderte. Por favor deja tu mensaje después del tono y te contactaremos a la brevedad.";
  return sendTwiml(res, voicemailTwiml(req, prompt));
});

// 3) Buzón grabado. Twilio manda RecordingUrl + RecordingDuration.
router.post("/voicemail", verifySignature, async (req, res) => {
  const b = req.body || {};
  const callSid = b.CallSid;
  const recordingUrl = b.RecordingUrl ? `${b.RecordingUrl}.mp3` : null;
  const recordingSeconds = b.RecordingDuration ? Number(b.RecordingDuration) : null;

  await safe("persist voicemail", () =>
    store.persistRawEvent({
      eventType: "voicemail",
      callSid,
      payload: b,
      sigVerified: req.twilioSigOk,
    })
  );
  await safe("update voicemail", () =>
    store.updateVoicemail({ callSid, recordingUrl, recordingSeconds })
  );

  await safe("chatwoot voicemail", async () => {
    const call = await store.getCall(callSid);
    if (!call?.chatwoot_conversation_id || !call?.chatwoot_source_id) return;
    // Link al proxy autenticado (la RecordingUrl cruda exige credenciales Twilio).
    const playUrl = `${publicBase(req)}/twilio-voice/recording/${callSid}`;
    await chatwoot.postMessage({
      sourceId: call.chatwoot_source_id,
      conversationId: Number(call.chatwoot_conversation_id),
      content: `🎙️ Buzón de voz (${recordingSeconds ?? 0}s)${recordingUrl ? `: ${playUrl}` : ""}`,
    });
  });

  const bye = process.env.TWILIO_VOICE_GOODBYE || "Gracias por tu mensaje. Hasta pronto.";
  return sendTwiml(res, twiml.response(twiml.say(bye, { language: lang() }) + twiml.hangup()));
});

// 4) (Opcional) statusCallback de la llamada completa. Solo persiste.
router.post("/status", verifySignature, async (req, res) => {
  const b = req.body || {};
  await safe("persist status", () =>
    store.persistRawEvent({
      eventType: "status",
      callSid: b.CallSid,
      payload: b,
      sigVerified: req.twilioSigOk,
    })
  );
  return res.status(204).end();
});

// 5) Proxy autenticado de la grabación. Las RecordingUrl de Twilio requieren
// HTTP Basic (AccountSid:AuthToken); este endpoint la stremea para que el
// agente la reproduzca desde el link en Chatwoot. URL-capability: el CallSid
// (34 chars aleatorios) actúa de token.
router.get("/recording/:callSid", async (req, res) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    return res.status(503).send("twilio credentials not configured");
  }
  const call = await safe("get call for recording", () =>
    store.getCall(req.params.callSid)
  );
  if (!call?.recording_url) return res.status(404).send("recording not found");

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const upstream = await fetch(call.recording_url, {
    headers: { Authorization: `Basic ${auth}` },
  }).catch(() => null);
  if (!upstream || !upstream.ok) {
    return res.status(502).send("upstream error");
  }
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
  const buf = Buffer.from(await upstream.arrayBuffer());
  return res.send(buf);
});

export default router;
