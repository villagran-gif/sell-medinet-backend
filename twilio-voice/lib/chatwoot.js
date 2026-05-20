// Cliente del canal API de Chatwoot para registrar llamadas de voz como
// conversaciones. Mismo patrón que tiktok-bridge/chatwoot.js: usa el endpoint
// público `/public/api/v1/inboxes/{identifier}` de un inbox tipo "API". El
// `identifier` del inbox actúa de credencial — no requiere api_access_token.
//
// Se activa solo si `CHATWOOT_VOICE_INBOX_IDENTIFIER` está seteado y
// `TWILIO_VOICE_CHATWOOT_ENABLED` != "false". Si no, `chatwootEnabled()`
// devuelve false y la telefonía funciona igual (sin registrar en Chatwoot).

const BASE = (
  process.env.CHATWOOT_BASE_URL ||
  process.env.CHATWOOT_API_URL ||
  "https://app.chatwoot.com"
).replace(/\/+$/, "");

export function chatwootEnabled() {
  return (
    process.env.TWILIO_VOICE_CHATWOOT_ENABLED !== "false" &&
    !!process.env.CHATWOOT_VOICE_INBOX_IDENTIFIER
  );
}

function inboxIdentifier() {
  return process.env.CHATWOOT_VOICE_INBOX_IDENTIFIER;
}

function publicUrl(path) {
  return `${BASE}/public/api/v1/inboxes/${inboxIdentifier()}${path}`;
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    throw new Error(`Chatwoot ${res.status}: ${text.slice(0, 300)}`);
  }
  return body;
}

// `source_id` estable por llamante (E.164 sin separadores, prefijo tel:).
function sourceIdFor(phone) {
  return `tel:${String(phone || "").replace(/[^\d+]/g, "")}`;
}

export async function ensureContact({ phone, name }) {
  const sourceId = sourceIdFor(phone);
  await request(publicUrl("/contacts"), {
    method: "POST",
    body: JSON.stringify({
      source_id: sourceId,
      name: name || phone,
      identifier: sourceId,
    }),
  });
  return { sourceId };
}

export async function createConversation({ sourceId }) {
  const conv = await request(publicUrl(`/contacts/${sourceId}/conversations`), {
    method: "POST",
    body: JSON.stringify({}),
  });
  return { conversationId: conv.id };
}

export async function postMessage({ sourceId, conversationId, content }) {
  return request(
    publicUrl(`/contacts/${sourceId}/conversations/${conversationId}/messages`),
    {
      method: "POST",
      body: JSON.stringify({ content, message_type: "incoming" }),
    }
  );
}
