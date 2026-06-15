// Acceso a grabaciones de Twilio.
//
// La grabación se genera cuando Chatwoot devuelve TwiML con record="true"
// en la llamada (default del canal Voice). Toma unos segundos en estar
// `status=completed` después que termina la llamada; por eso el handler
// reintenta con backoff hasta encontrarla.

const TWILIO_BASE = "https://api.twilio.com/2010-04-01/Accounts";

function basicAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) {
    throw new Error("missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN");
  }
  return "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64");
}

export async function findRecordingByCallSid(callSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = `${TWILIO_BASE}/${sid}/Calls/${callSid}/Recordings.json`;
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) {
    throw new Error(`twilio recordings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const recs = data.recordings || [];
  return recs.find((r) => r.status === "completed") || null;
}

export async function downloadRecordingMp3(recordingSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = `${TWILIO_BASE}/${sid}/Recordings/${recordingSid}.mp3`;
  const res = await fetch(url, { headers: { Authorization: basicAuth() } });
  if (!res.ok) {
    throw new Error(`twilio download ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
