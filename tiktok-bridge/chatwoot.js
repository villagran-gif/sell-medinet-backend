const BASE = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';

function inboxId() {
  const id = process.env.CHATWOOT_TIKTOK_INBOX_IDENTIFIER;
  if (!id) throw new Error('CHATWOOT_TIKTOK_INBOX_IDENTIFIER not set');
  return id;
}

function publicUrl(path) {
  return `${BASE}/public/api/v1/inboxes/${inboxId()}${path}`;
}

async function request(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`Chatwoot ${res.status}: ${text}`);
  return body;
}

export async function ensureContact({ sourceId, name, avatarUrl, identifier }) {
  return request(publicUrl('/contacts'), {
    method: 'POST',
    body: JSON.stringify({
      source_id: sourceId,
      name,
      avatar_url: avatarUrl,
      identifier,
    }),
  });
}

export async function ensureConversation({ contactSourceId }) {
  return request(publicUrl(`/contacts/${contactSourceId}/conversations`), {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function postIncomingMessage({ contactSourceId, conversationId, content, attachments }) {
  return request(publicUrl(`/contacts/${contactSourceId}/conversations/${conversationId}/messages`), {
    method: 'POST',
    body: JSON.stringify({ content, message_type: 'incoming', attachments }),
  });
}
