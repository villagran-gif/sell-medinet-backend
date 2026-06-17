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

// --- Helpers para missed-call follow-up via WhatsApp ---

export async function searchContactByPhone(phone) {
  const q = encodeURIComponent(phone);
  return api(`/contacts/search?q=${q}&include_contact_inboxes=false`);
}

export async function createContact({ name, phone_number, inbox_id, identifier }) {
  return api(`/contacts`, {
    method: "POST",
    body: JSON.stringify({
      inbox_id,
      name: name || phone_number,
      phone_number,
      identifier: identifier || phone_number,
    }),
  });
}

export async function createConversation({ source_id, inbox_id, contact_id, message }) {
  return api(`/conversations`, {
    method: "POST",
    body: JSON.stringify({ source_id, inbox_id, contact_id, message }),
  });
}

export async function toggleConversationStatus(conversationId, status = "resolved") {
  return api(`/conversations/${conversationId}/toggle_status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export async function addConversationLabels(conversationId, labels) {
  return api(`/conversations/${conversationId}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels }),
  });
}

export async function updateContactAttributes(contactId, custom_attributes) {
  return api(`/contacts/${contactId}`, {
    method: "PATCH",
    body: JSON.stringify({ custom_attributes }),
  });
}
