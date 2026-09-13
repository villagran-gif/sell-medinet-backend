import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchPending } from './index.js';
import { handleInboundEvent } from '../antonia-bridge/index.js';
function queue() {
  const event = { id: 1, event_type: 'message_created', payload: {}, processed_at: null, dispatch_state: null, error: null };
  const pool = { async query(sql, args = []) {
    if (sql.startsWith('WITH next')) {
      if (event.dispatch_state || event.processed_at || event.error) return { rows: [] };
      event.dispatch_state = 'processing'; return { rows: [{ ...event }] };
    }
    if (sql.includes('SET processed_at=now()')) { event.processed_at = new Date(); event.dispatch_state = 'delivered'; }
    if (sql.includes('error=$2')) { event.dispatch_state = 'needs_review'; event.error = args[1]; }
    return { rows: [] };
  } };
  return { pool, event };
}
test('a claim stays unprocessed until confirmed delivery', async () => {
  const { pool, event } = queue();
  const result = await dispatchPending({ pool, handlerLoader: async () => async () => {
    assert.equal(event.processed_at, null); assert.equal(event.dispatch_state, 'processing'); return { forwarded: true };
  } });
  assert.equal(result.dispatched, 1); assert.equal(event.dispatch_state, 'delivered'); assert.ok(event.processed_at);
});
test('timeout is visible for review and is not replayed on the next dispatch', async () => {
  const { pool, event } = queue(); let calls = 0;
  const handlerLoader = async () => async () => { calls++; throw new Error('delivery_uncertain: timeout'); };
  const first = await dispatchPending({ pool, handlerLoader });
  const second = await dispatchPending({ pool, handlerLoader });
  assert.equal(first.errors, 1); assert.equal(second.scanned, 0); assert.equal(calls, 1);
  assert.equal(event.processed_at, null); assert.equal(event.dispatch_state, 'needs_review'); assert.match(event.error, /timeout/);
});
test('handler load failure and skipped delivery remain unprocessed', async () => {
  for (const handlerLoader of [async () => { throw new Error('load_failed'); }, async () => async () => ({ skipped: true })]) {
    const { pool, event } = queue(); await dispatchPending({ pool, handlerLoader });
    assert.equal(event.processed_at, null); assert.equal(event.dispatch_state, 'needs_review');
  }
});
test('concurrent dispatchers do not forward the same claim twice', async () => {
  const { pool } = queue(); let calls = 0;
  const handlerLoader = async () => async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return { forwarded: true }; };
  await Promise.all([dispatchPending({ pool, handlerLoader }), dispatchPending({ pool, handlerLoader })]);
  assert.equal(calls, 1);
});
test('bridge requires configuration and checks JSON success as well as HTTP status', async () => {
  const original = { url: process.env.CLINYCO_AI_BASE_URL, token: process.env.CHATWOOT_ADAPTER_TOKEN };
  try {
    delete process.env.CLINYCO_AI_BASE_URL;
    await assert.rejects(handleInboundEvent({ payload: {} }), /not_configured/);
    process.env.CLINYCO_AI_BASE_URL = 'https://antonia.example.test'; process.env.CHATWOOT_ADAPTER_TOKEN = 'synthetic-token';
    for (const result of [{ ok: false }, { skipped: true }]) await assert.rejects(handleInboundEvent({ payload: {} }, { fetchImpl: async () => Response.json(result) }), /not_confirmed/);
    assert.deepEqual(await handleInboundEvent({ payload: {} }, { fetchImpl: async () => Response.json({ ok: true, skipped: 'non_user_message' }) }), { forwarded: true });
    await assert.rejects(handleInboundEvent({ payload: {} }, { fetchImpl: async () => Response.json({ error: 'ai_quota_exhausted' }, { status: 503 }) }), /ai_quota_exhausted/);
  } finally {
    if (original.url === undefined) delete process.env.CLINYCO_AI_BASE_URL; else process.env.CLINYCO_AI_BASE_URL = original.url;
    if (original.token === undefined) delete process.env.CHATWOOT_ADAPTER_TOKEN; else process.env.CHATWOOT_ADAPTER_TOKEN = original.token;
  }
});
