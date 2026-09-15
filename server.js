import express from "express";
import { randomUUID } from "crypto";
import { createTiktokBridgeRouter } from "./tiktok-bridge/index.js";
import { createChatwootWebhookRouter } from "./chatwoot-webhook/index.js";
import { createConfirmationsRouter } from "./confirmations/index.js";

import { attendanceRouter } from './attendance/router.js';
import { tick as attendanceTick, startupTrial } from './attendance/engine.js';
import { webhookRouter as directWebhook, operatorRouter as directOperator } from './attendance-direct/router.js';
import { processEvents as directTick, request as directRequest } from './attendance-direct/engine.js';
import { TRIAL_PHONE } from './attendance-direct/meta.js';
import { readAppointment as readAttendanceAppointment } from './attendance/clients.js';
import { eligible as attendanceEligible } from './attendance/policy.js';
const app = express();
const PORT = process.env.PORT || 3000;

const IDENTIFIER_TYPES = { DNI: "DNI", RUN: "RUN" };

// Raw bytes are required for Meta HMAC verification, before the JSON parser.
if (process.env.ATTENDANCE_DIRECT_ENABLED === 'true') {
  app.use('/attendance-direct/webhook', directWebhook());
}
app.use(express.json({ limit: "1mb" }));
if (process.env.ATTENDANCE_DIRECT_ENABLED === 'true') {
  app.use('/attendance-direct', directOperator());
  const directTestSend = process.env.ATTENDANCE_DIRECT_MODE !== 'live' && process.env.ATTENDANCE_DIRECT_TEST_SEND_ENABLED === 'true';
  let busy = false;
  setInterval(async () => {
    const inboundVerified = process.env.ATTENDANCE_DIRECT_CUTOVER_VERIFIED === 'true' || (process.env.ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_ENABLED === 'true' && process.env.ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_VERIFIED === 'true');
    const liveSend = process.env.ATTENDANCE_DIRECT_SEND_ENABLED === 'true' && inboundVerified;
    if (busy || (!liveSend && !directTestSend)) return;
    busy = true;
    try { await directTick(); } catch { console.error('[attendance-direct] worker unavailable'); }
    finally { busy = false; }
  }, 5000).unref();
  if (process.env.ATTENDANCE_DIRECT_MODE === 'live' && process.env.ATTENDANCE_DIRECT_STARTUP_LIVE_BATCH_COMMIT === 'true') {
    const batchKey=String(process.env.ATTENDANCE_DIRECT_STARTUP_LIVE_BATCH_KEY||'').trim();
    const ids=[...new Set(String(process.env.ATTENDANCE_DIRECT_STARTUP_LIVE_BATCH_IDS||'').split(',').map(x=>Number(x.trim())).filter(x=>Number.isSafeInteger(x)&&x>0))].slice(0,20);
    if(!/^[a-zA-Z0-9_-]{8,50}$/.test(batchKey)||!ids.length) console.error('[attendance-direct/startup-live-batch] invalid_config');
    else (async()=>{
      const summary={sent:0,duplicate:0,skipped:0,review:0};
      for(const id of ids){
        try{
          const a=await readAttendanceAppointment(id);
          if(!attendanceEligible(a)){summary.skipped++;console.log('[attendance-direct/startup-live-batch]',JSON.stringify({id,status:'ineligible'}));continue;}
          const result=await directRequest(a,{trial:false,key:`${batchKey}-${id}-${a.fingerprint.slice(0,12)}`,actor:'startup-live-batch'});
          if(result?.duplicate)summary.duplicate++;else summary.sent++;
          console.log('[attendance-direct/startup-live-batch]',JSON.stringify({id,state:result?.state||null,delivery:result?.delivery||null,duplicate:!!result?.duplicate}));
        }catch(e){summary.review++;console.error('[attendance-direct/startup-live-batch]',id,e.message);}
      }
      console.log('[attendance-direct/startup-live-batch-summary]',JSON.stringify(summary));
    })();
  }

  if (directTestSend && process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_KEY) {
    const tomorrow = new Date(Date.now()+86400000).toISOString().slice(0,10);
    const a={id:Number(process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_ID||990000001),phone:TRIAL_PHONE,
      patient:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_PATIENT||'Rodrigo',
      professionalId:Number(process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_PROFESSIONAL_ID||1),
      professional:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_PROFESSIONAL||'Profesional de prueba',
      branchId:Number(process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_BRANCH_ID||1),
      branch:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_BRANCH||'Prueba',
      type:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_TYPE||'PRUEBA, sin cita real',
      date:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_DATE||tomorrow,time:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_TIME||'17:30'};
    directRequest(a,{trial:true,replaceTrial:true,key:process.env.ATTENDANCE_DIRECT_STARTUP_TRIAL_KEY,actor:'startup-trial'})
      .then(r=>console.log('[attendance-direct/startup-trial]',JSON.stringify(r))).catch(e=>console.error('[attendance-direct/startup-trial]',e.message));
  }
}

// ======================
// tiktok-bridge (opt-in vía TIKTOK_BRIDGE_ENABLED=true)
// ManyChat (TikTok gateway) <-> Chatwoot API inbox.
// ======================
if (process.env.TIKTOK_BRIDGE_ENABLED === "true") {
  app.use("/webhooks", createTiktokBridgeRouter());
  console.log("[tiktok-bridge] mounted at /webhooks");
} else {
  console.log("[tiktok-bridge] disabled");
}

// ======================
// chatwoot-webhook (opt-in vía CHATWOOT_WEBHOOK_ENABLED=true)
// Receptor durable de eventos de Chatwoot.
// ======================
if (process.env.CHATWOOT_WEBHOOK_ENABLED === "true") {
  app.use(
    "/chatwoot-webhook",
    createChatwootWebhookRouter({
      autoMigrate: process.env.CHATWOOT_AUTO_MIGRATE !== "false",
    })
  );
  console.log("[chatwoot-webhook] mounted at /chatwoot-webhook");
} else {
  console.log("[chatwoot-webhook] disabled");
}

// ======================
// confirmations (opt-in vía CONFIRMATIONS_ENABLED=true)
// MelanIA: confirmaciones de citas Medinet vía Chatwoot Cloud.
// ======================
if (process.env.CONFIRMATIONS_ENABLED === "true") {
  app.use(
    "/confirmations",
    createConfirmationsRouter({
      autoMigrate: process.env.CONFIRMATIONS_AUTO_MIGRATE !== "false",
    })
  );
  console.log("[confirmations] mounted at /confirmations");
} else {
  console.log("[confirmations] disabled");
}

if (process.env.ATTENDANCE_ENABLED === 'true') {
  app.use('/attendance', attendanceRouter());
  const runAttendance = () => attendanceTick().catch(e => console.error('[attendance/tick]',e.message));
  setInterval(runAttendance, 30000).unref();
  console.log('[attendance] dedicated inbox 107690 enabled');
  startupTrial().then(r=>{if(r)console.log('[attendance/trial]',JSON.stringify(r));}).catch(e=>console.error('[attendance/trial]',e.message));
}

// ======================
// In-memory store con TTL para bridge Medinet
// ======================
const TTL_MINUTES = Number(process.env.TTL_MINUTES || 60);
const TTL_MS = Math.max(1, TTL_MINUTES) * 60 * 1000;
const store = new Map();

function cleanupStore() {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (!v || v.expiresAt <= now) store.delete(k);
  }
}
setInterval(cleanupStore, 60 * 1000).unref();

const normalizeDni = (value = "") => value.replace(/\D/g, "");

const computeRunVerifier = (digits) => {
  let sum = 0;
  let multiplier = 2;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    sum += Number(digits[index]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }

  const remainder = 11 - (sum % 11);
  if (remainder === 11) return "0";
  if (remainder === 10) return "K";
  return String(remainder);
};

const normalizeAndValidateRun = (value = "") => {
  const normalizedInput = String(value).toUpperCase().trim();
  const compactValue = normalizedInput.replace(/[.\s-]+/g, "");

  if (!compactValue) return { isValid: false, error: "RUN vacío" };
  if (!/^\d{1,8}[0-9K]$/.test(compactValue)) {
    return { isValid: false, error: "RUN inválido. Usa un RUN chileno válido con DV (0-9 o K)" };
  }

  const body = compactValue.slice(0, -1);
  const verifier = compactValue.slice(-1);
  const expectedVerifier = computeRunVerifier(body);

  if (verifier !== expectedVerifier) {
    return { isValid: false, error: "RUN inválido. Dígito verificador incorrecto" };
  }

  return { isValid: true, normalized: `${body}-${verifier}` };
};

const formatRunWithDots = (normalizedRun = "") => {
  const [body, verifier] = normalizedRun.split("-");
  const bodyWithDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${bodyWithDots}-${verifier}`;
};

const validateApiKey = (req, res) => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    res.status(500).json({ status: "error", message: "Backend sin API_KEY configurada." });
    return false;
  }

  if (req.header("X-API-Key") !== apiKey) {
    res.status(401).json({ status: "error", message: "API key inválida" });
    return false;
  }
  return true;
};

const MEDINET_ORIGIN = "https://clinyco.medinetapp.com";

function setMedinetCors(res) {
  res.setHeader("Access-Control-Allow-Origin", MEDINET_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

app.options("/medinet/payload/:key", (_req, res) => {
  setMedinetCors(res);
  return res.status(204).send("");
});

app.get("/", (_req, res) => res.send("OK - clinyco integration gateway"));

app.post("/medinet/import", (req, res) => {
  if (!validateApiKey(req, res)) return;

  const payload = req.body || {};
  const key = `mf_${randomUUID()}`;
  store.set(key, { payload, expiresAt: Date.now() + TTL_MS });

  const baseMedinetNew = String(
    process.env.MEDINET_NEW_URL || "https://clinyco.medinetapp.com/pacientes/nuevo/"
  )
    .trim()
    .replace(/\/?$/, "/");

  return res.status(200).json({
    status: "ok",
    message: "Listo ✅ (payload guardado)",
    key,
    download_url: `${baseMedinetNew}?mf_key=${encodeURIComponent(key)}`,
  });
});

app.get("/medinet/payload/:key", (req, res) => {
  setMedinetCors(res);

  const key = String(req.params.key || "").trim();
  if (!key) return res.status(400).json({ status: "error", message: "key requerido" });

  const entry = store.get(key);
  if (!entry) return res.status(404).json({ status: "error", message: "key no encontrada/expirada" });

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return res.status(404).json({ status: "error", message: "key expirada" });
  }

  return res.status(200).json(entry.payload);
});

app.post("/medinet/search", (req, res) => {
  if (!validateApiKey(req, res)) return;

  const identifierType = String(req.body?.identifierType || "").toUpperCase();
  const identifierValue = String(req.body?.identifierValue || "");

  if (!Object.values(IDENTIFIER_TYPES).includes(identifierType)) {
    return res.status(400).json({ status: "error", message: "identifierType inválido. Usa DNI o RUN" });
  }
  if (!identifierValue.trim()) {
    return res.status(400).json({ status: "error", message: "identifierValue es requerido" });
  }

  let normalizedIdentifierValue;
  let responseIdentifierValue;

  if (identifierType === IDENTIFIER_TYPES.DNI) {
    normalizedIdentifierValue = normalizeDni(identifierValue);
    if (!normalizedIdentifierValue) {
      return res.status(400).json({ status: "error", message: "DNI inválido. Debe contener solo dígitos" });
    }
    responseIdentifierValue = normalizedIdentifierValue;
  }

  if (identifierType === IDENTIFIER_TYPES.RUN) {
    const runResult = normalizeAndValidateRun(identifierValue);
    if (!runResult.isValid) {
      return res.status(400).json({ status: "error", message: runResult.error });
    }
    normalizedIdentifierValue = runResult.normalized;
    responseIdentifierValue = formatRunWithDots(normalizedIdentifierValue);
  }

  return res.status(200).json({
    status: "ok",
    message: "Búsqueda preparada",
    search: {
      identifierType,
      identifierValue: responseIdentifierValue,
      identifierValueNormalized: normalizedIdentifierValue,
      backendFieldMap: {
        type: identifierType === IDENTIFIER_TYPES.RUN ? "run" : "dni",
        value: normalizedIdentifierValue,
      },
    },
  });
});

app.use((error, _req, res, next) => {
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ status: "error", message: "JSON inválido en el body" });
  }
  return next(error);
});

const server = app.listen(PORT, () => console.log(`Clinyco integration gateway listening on ${PORT}`));

const SHUTDOWN_TIMEOUT_MS = 25_000;
let shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recibido, cerrando servidor...`);

  const forceExit = setTimeout(() => {
    console.error("[shutdown] timeout alcanzado, forzando salida");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      console.error("[shutdown] error cerrando HTTP:", err);
      process.exit(1);
    }
    console.log("[shutdown] HTTP cerrado, saliendo limpio");
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
