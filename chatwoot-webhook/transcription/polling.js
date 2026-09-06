// Polling de respaldo: cada 2 min revisa grabaciones recientes de Twilio
// y para cada una que no esté ya transcrita, busca la conversación de
// Chatwoot por número y dispara la transcripción.
//
// ADEMÁS: detecta llamadas perdidas (duración baja + sin grabación) y
// dispara el handler de missed-call → template WhatsApp.
//
// Sirve como safety net si el StatusCallback de Twilio falla por algún
// motivo (timeout, drop de red, etc).

import { getPool } from "../db.js";
import { transcribeByCallSid, findVoiceInboxId } from "./handler.js";
import { searchContactByPhone, getContactConversations } from "../lib/chatwoot-api.js";
import { followupFromPolling } from "../missed-call/handler.js";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_WINDOW_MIN = 20;

let timer = null;
let tickInFlight = false;

function basicAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error("missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
  return "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64");
}

async function listRecentRecordings(minutesBack) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const dateAfter = new Date(Date.now() - minutesBack * 60_000).toISOString().split("T")[0];
  const url = `${TWILIO_BASE}/${sid}/Recordings.json?DateCreated%3E=${encodeURIComponent(dateAfter)}&PageSize=50`;
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) {
    throw new Error(`twilio recordings ${res.status}`);
  }
  const data = await res.json();
  return data.recordings || [];
}

async function getCallFrom(callSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`${TWILIO_BASE}/${sid}/Calls/${callSid}.json`, {
    headers: { Authorization: basicAuth() },
  });
  if (!res.ok) return null;
  const c = await res.json();
  return c?.from || null;
}

// Lista llamadas inbound al número de Twilio en los últimos N min.
// Usado para detectar missed calls (no aparecen en /Recordings).
async function listRecentInboundCalls(minutesBack, toNumber) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const dateAfter = new Date(Date.now() - minutesBack * 60_000).toISOString().split("T")[0];
  const params = new URLSearchParams({
    "StartTime>=": dateAfter,
    PageSize: "100",
  });
  if (toNumber) params.set("To", toNumber);
  const url = `${TWILIO_BASE}/${sid}/Calls.json?${params.toString()}`;
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) throw new Error(`twilio calls ${res.status}`);
  const data = await res.json();
  return (data.calls || []).filter((c) => c.direction === "inbound");
}

// Busca la conversación de Chatwoot del cliente (igual que handler.transcribeByCallSid).
async function findVoiceConv(phone) {
  const search = await searchContactByPhone(phone);
  const contacts = search?.payload || [];
  const target = String(phone || "").replace(/\D/g, "");
  const match = contacts.find((c) => String(c?.phone_number || "").replace(/\D/g, "") === target);
  if (!match) return null;
  const convs = await getContactConversations(match.id);
  const list = convs?.payload || convs?.data?.payload || convs || [];
  const voiceInboxId = await findVoiceInboxId();
  const voiceConvs = list.filter((c) => {
    if (voiceInboxId) return c.inbox_id === voiceInboxId;
    const ct = (c.meta?.channel || c.inbox?.channel_type || "").toLowerCase();
    return ct.includes("voice");
  });
  voiceConvs.sort((a, b) => {
    const ta = new Date(a.created_at || a.timestamp || 0).getTime();
    const tb = new Date(b.created_at || b.timestamp || 0).getTime();
    return tb - ta;
  });
  return voiceConvs[0] || null;
}

// Detecta y dispara handler para llamadas perdidas.
// Heurística: inbound + status=completed + duration < threshold (default 15s)
// = el agente probablemente no atendió.
async function tickMissedCalls(window) {
  if (process.env.CHATWOOT_MISSED_CALL_ENABLED !== "true") return;
  const targetNumber = process.env.CHATWOOT_VOICE_NUMBER || "+56229148460";
  const threshold = Number(process.env.CHATWOOT_MISSED_DURATION_THRESHOLD) || 15;

  let calls;
  try {
    calls = await listRecentInboundCalls(window, targetNumber);
  } catch (err) {
    console.error("[polling-missed] list calls failed:", err.message);
    return;
  }

  const pool = getPool();
  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let nomatch = 0;

  // Twilio puede devolver varias llamadas recientes del mismo número. La búsqueda
  // de contacto + conversaciones en Chatwoot es idéntica para todas ellas dentro
  // del mismo tick, por lo que la hacemos una sola vez por teléfono.
  const voiceConvByPhone = new Map();

  for (const call of calls) {
    if (call.status !== "completed") continue;
    const dur = Number(call.duration) || 0;
    if (dur >= threshold) continue; // probablemente atendida

    const callSid = call.sid;
    const from = call.from;
    if (!callSid || !from) continue;

    // Skip rápido si este CallSid ya quedó asociado a un follow-up.
    const existing = await pool.query(
      `SELECT status FROM chatwoot.missed_call_followups WHERE call_sid = $1 LIMIT 1`,
      [callSid]
    );
    if (existing.rowCount > 0) {
      skipped++;
      continue;
    }

    try {
      const phoneKey = String(from).replace(/\D/g, "") || String(from);
      let conv;
      if (voiceConvByPhone.has(phoneKey)) {
        conv = voiceConvByPhone.get(phoneKey);
      } else {
        conv = await findVoiceConv(from);
        voiceConvByPhone.set(phoneKey, conv || null);
      }

      if (!conv) {
        nomatch++;
        continue;
      }

      const conversationId = conv.display_id || conv.id;
      if (!conversationId) {
        nomatch++;
        continue;
      }

      // La idempotencia durable de missed_call_followups está definida por
      // conversation_id. Comprobarla aquí evita contar como "processed" un
      // follow-up que ya estaba resuelto y evita trabajo adicional del handler.
      const existingConversation = await pool.query(
        `SELECT status FROM chatwoot.missed_call_followups WHERE conversation_id = $1 LIMIT 1`,
        [conversationId]
      );
      if (existingConversation.rowCount > 0) {
        const status = existingConversation.rows[0].status;
        if (status === "sent" || status === "processing" || status === "skipped") {
          skipped++;
          continue;
        }
      }

      await followupFromPolling({
        conversationId,
        callSid,
        customerPhone: from,
        customerName: conv?.meta?.sender?.name || "",
      });
      processed++;
    } catch (err) {
      errors++;
      console.error(`[polling-missed] ${callSid} failed:`, err.message);
    }
  }

  if (processed > 0 || errors > 0 || nomatch > 0) {
    console.log(
      `[polling-missed] processed=${processed} skipped=${skipped} nomatch=${nomatch} errors=${errors}`
    );
  }
}

async function tick() {
  if (tickInFlight) {
    console.warn("[polling] tick skipped: previous tick still running");
    return;
  }

  tickInFlight = true;
  try {
    const window = Number(process.env.CHATWOOT_POLLING_WINDOW_MIN) || DEFAULT_WINDOW_MIN;

    // Procesar transcripciones (grabaciones nuevas)
    await tickTranscriptions(window);

    // Procesar missed calls (llamadas con dur baja, sin grabación)
    await tickMissedCalls(window);
  } finally {
    tickInFlight = false;
  }
}

async function tickTranscriptions(window) {
  const pool = getPool();

  let recordings;
  try {
    recordings = await listRecentRecordings(window);
  } catch (err) {
    console.error("[polling] list recordings failed:", err.message);
    return;
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  let nomatch = 0;

  for (const rec of recordings) {
    const callSid = rec.call_sid;
    if (!callSid) continue;

    const existing = await pool.query(
      `SELECT status FROM chatwoot.call_transcriptions WHERE call_sid = $1 LIMIT 1`,
      [callSid]
    );
    if (existing.rowCount > 0 && existing.rows[0].status === "done") {
      skipped++;
      continue;
    }

    const from = await getCallFrom(callSid);
    if (!from) {
      skipped++;
      continue;
    }

    try {
      await transcribeByCallSid({ callSid, fromNumber: from });
      processed++;
    } catch (err) {
      if (err.message?.includes("no voice conversation")) {
        nomatch++;
      } else {
        errors++;
        console.error(`[polling] ${callSid} failed:`, err.message);
      }
    }
  }

  if (processed > 0 || errors > 0 || nomatch > 0) {
    console.log(
      `[polling] processed=${processed} skipped=${skipped} nomatch=${nomatch} errors=${errors}`
    );
  }
}

export function startPolling({
  intervalMs = Number(process.env.CHATWOOT_POLLING_INTERVAL_MS) || DEFAULT_INTERVAL_MS,
} = {}) {
  if (timer) return;
  if (process.env.CHATWOOT_POLLING_ENABLED !== "true") {
    console.log("[polling] disabled (set CHATWOOT_POLLING_ENABLED=true to enable)");
    return;
  }

  // Este proceso es un safety net, no un sistema en tiempo real. Un intervalo
  // menor a 2 minutos multiplica consultas innecesarias a Chatwoot y puede
  // agotar su rate limit. Clampeamos configuraciones heredadas más agresivas.
  const requestedIntervalMs = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  const effectiveIntervalMs = Math.max(DEFAULT_INTERVAL_MS, requestedIntervalMs);
  if (effectiveIntervalMs !== requestedIntervalMs) {
    console.warn(
      `[polling] interval=${requestedIntervalMs}ms demasiado agresivo; usando mínimo ${effectiveIntervalMs}ms`
    );
  }

  tick();
  timer = setInterval(tick, effectiveIntervalMs);
  if (timer.unref) timer.unref();
  console.log(
    `[polling] started: interval=${effectiveIntervalMs}ms window=${process.env.CHATWOOT_POLLING_WINDOW_MIN || DEFAULT_WINDOW_MIN}min`
  );
}

export function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
