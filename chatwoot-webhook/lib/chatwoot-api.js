// Cliente mínimo de la Application API de Chatwoot.
//
// Usa `api_access_token` (User Access Token o Agent Bot Token). El account_id
// y el base_url vienen de env vars — se pueden testear contra una instancia
// self-hosted cambiando CHATWOOT_BASE_URL.

function baseUrl() {
  return (process.env.CHATWOOT_BASE_URL || "https://app.chatwoot.com").replace(/\/+$/, "");
}

function accountId() {
  const id = process.env.CHATWOOT_ACCOUNT_ID;
  if (!id) throw new Error("missing CHATWOOT_ACCOUNT_ID");
  return id;
}

function token() {
  const t = process.env.CHATWOOT_API_TOKEN;
  if (!t) throw new Error("missing CHATWOOT_API_TOKEN");
  return t;
}

async function api(path, opts = {}) {
  const url = `${baseUrl()}/api/v1/accounts/${accountId()}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      api_access_token: token(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const snippet = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`chatwoot ${path} ${res.status}: ${String(snippet).slice(0, 200)}`);
  }
  return body;
}

export async function getConversation(conversationId) {
  return api(`/conversations/${conversationId}`);
}

export async function postPrivateNote(conversationId, content) {
  return api(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      message_type: "outgoing",
      private: true,
    }),
  });
}
