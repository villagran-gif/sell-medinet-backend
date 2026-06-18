// Polling de respaldo: cada 2 min revisa grabaciones recientes de Twilio
// y para cada una que no esté ya transcrita, busca la conversación de
// Chatwoot por número y dispara la transcripción.
//
// Sirve como safety net si el StatusCallback de Twilio falla por algún
// motivo (timeout, drop de red, etc).

import { getPool } from "../db.js";
import { transcribeByCallSid } from "./handler.js";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01/Accounts";
const DEFAULT_INTERVAL_MS = 120_000;
const DEFAULT_WINDOW_MIN = 20;

let timer = null;

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

async function tick() {
  const pool = getPool();
  const window = Number(process.env.CHATWOOT_POLLING_WINDOW_MIN) || DEFAULT_WINDOW_MIN;

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
  tick();
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  console.log(`[polling] started: interval=${intervalMs}ms window=${process.env.CHATWOOT_POLLING_WINDOW_MIN || DEFAULT_WINDOW_MIN}min`);
}

export function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
