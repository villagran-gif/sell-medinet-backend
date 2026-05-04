const BASE = 'https://api.manychat.com';

function authHeader() {
  const key = process.env.MANYCHAT_API_KEY;
  if (!key) throw new Error('MANYCHAT_API_KEY not set');
  return `Bearer ${key}`;
}

export async function getSubscriberInfo(subscriberId) {
  const res = await fetch(`${BASE}/fb/subscriber/getInfo?subscriber_id=${subscriberId}`, {
    headers: { Authorization: authHeader() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') {
    throw new Error(`ManyChat getInfo ${res.status}: ${JSON.stringify(data)}`);
  }
  return data.data;
}

export async function sendDirectMessage({ subscriberId, text, messageTag = 'ACCOUNT_UPDATE' }) {
  const res = await fetch(`${BASE}/fb/sending/sendContent`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          messages: [{ type: 'text', text }],
        },
      },
      message_tag: messageTag,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === 'error') {
    throw new Error(`ManyChat send ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export function verifyManyChatRequest(req) {
  const expected = process.env.MANYCHAT_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.get('X-Bridge-Secret') === expected;
}
