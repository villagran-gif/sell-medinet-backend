import test from 'node:test';
import assert from 'node:assert/strict';
import { isDryRun, startConversationWithTemplate, sendTemplateInConversation, sendTextMessage } from './chatwoot-client.js';

test('main WhatsApp channel guards (synthetic HTTP only)', async t => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  t.after(() => { process.env = saved; globalThis.fetch = originalFetch; });
  process.env.CHATWOOT_API_TOKEN = 'synthetic-token';
  process.env.CHATWOOT_DRY_RUN = 'false';
  delete process.env.CONFIRMATIONS_LIVE_SEND_ENABLED;
  assert.equal(isDryRun(), true, 'legacy live flag cannot activate confirmations');
  globalThis.fetch = () => { throw new Error('dry run must not access HTTP'); };
  await sendTextMessage({ conversationId: 9, content: 'synthetic' });
  process.env.CONFIRMATIONS_LIVE_SEND_ENABLED = 'true';
  process.env.CHATWOOT_INBOX_ID = '107690';
  let inbox = { id: 110652, phone_number: '+56 9 5338 6191', channel_type: 'Channel::Whatsapp' };
  let conversation = { id: 9, inbox_id: 110652 };
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    const body = options.method === 'POST' ? { id: 9, messages: [{ id: 10 }] }
      : url.includes('/inboxes/') ? inbox : conversation;
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const args = { contactId: 1, sourceId: '56900000000', templateName: 'synthetic' };
  await startConversationWithTemplate(args);
  assert.equal(JSON.parse(calls.at(-1).body).inbox_id, 110652);
  for (const send of [
    () => sendTextMessage({ conversationId: 9, content: 'synthetic' }),
    () => sendTemplateInConversation({ conversationId: 9, templateName: 'synthetic' }),
  ]) {
    calls = [];
    conversation = { id: 9, inbox_id: 107690 };
    await assert.rejects(send, /unverified channel/);
    assert.equal(calls.some(c => c.method === 'POST'), false);
    conversation = { id: 9, inbox_id: 110652 };
    await send();
    assert.equal(calls.at(-1).method, 'POST');
  }
  for (const bad of [
    { ...inbox, phone_number: '+56962718765' },
    { ...inbox, phone_number: undefined },
    { ...inbox, channel_type: 'Channel::Api' },
    { ...inbox, id: 107690 },
  ]) {
    inbox = bad;
    calls = [];
    await assert.rejects(() => startConversationWithTemplate(args), /channel unverified/);
    assert.equal(calls.some(c => c.method === 'POST'), false);
  }
  globalThis.fetch = async () => { throw new Error('read failed'); };
  await assert.rejects(() => startConversationWithTemplate(args), /read failed/);
});
