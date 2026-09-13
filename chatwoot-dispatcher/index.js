// A claim is not a delivery. Never automatically replay an uncertain patient
// message: the core may already have replied or booked an appointment.
import { getPool } from '../chatwoot-webhook/db.js';
import { parseRoutingConfig, resolveHandlerKeys } from './routing.js';

const schemaReady = new WeakMap();
export async function ensureDeliveryState(pool) {
  if (!schemaReady.has(pool)) schemaReady.set(pool, pool.query(`
    ALTER TABLE chatwoot.raw_events
      ADD COLUMN IF NOT EXISTS dispatch_state text,
      ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz,
      ADD COLUMN IF NOT EXISTS dispatch_finished_at timestamptz;
  `).catch(error => { schemaReady.delete(pool); throw error; }));
  await schemaReady.get(pool);
}
async function loadHandler(key) {
  if (key !== 'antonia') throw new Error('unknown_handler');
  return (await import('../antonia-bridge/index.js')).handleInboundEvent;
}
export async function dispatchPending({ limit = 50, pool = getPool(), handlerLoader = loadHandler, config = parseRoutingConfig() } = {}) {
  await ensureDeliveryState(pool);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
  await pool.query(`UPDATE chatwoot.raw_events SET dispatch_state='needs_review',
    dispatch_finished_at=now(),error='delivery_uncertain: interrupted dispatcher'
    WHERE dispatch_state='processing' AND dispatch_started_at<now()-interval '30 minutes' AND processed_at IS NULL`);
  const summary = { scanned: 0, dispatched: 0, errors: 0, byHandler: {} };
  for (let i = 0; i < safeLimit; i++) {
    // Reserve only the event being sent, so a slow request does not hold a batch.
    const { rows } = await pool.query(`WITH next AS (
      SELECT id FROM chatwoot.raw_events
      WHERE processed_at IS NULL AND error IS NULL AND dispatch_state IS NULL
        AND event_type='message_created'
      ORDER BY received_at ASC,id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE chatwoot.raw_events r SET dispatch_state='processing',dispatch_started_at=now()
      FROM next WHERE r.id=next.id RETURNING r.id,r.event_type,r.payload`);
    if (!rows.length) break;
    const ev = rows[0]; summary.scanned++;
    try {
      const keys = resolveHandlerKeys(ev.payload, config);
      if (!keys.length) throw new Error('no_handler');
      for (const key of keys) {
        const result = await (await handlerLoader(key))(ev);
        if (result?.forwarded !== true) throw new Error('delivery_not_confirmed');
        summary.byHandler[key] = (summary.byHandler[key] || 0) + 1;
      }
      await pool.query(`UPDATE chatwoot.raw_events SET processed_at=now(),dispatch_state='delivered',
        dispatch_finished_at=now(),error=NULL WHERE id=$1 AND dispatch_state='processing'`, [ev.id]);
      summary.dispatched++;
    } catch (error) {
      summary.errors++;
      await pool.query(`UPDATE chatwoot.raw_events SET dispatch_state='needs_review',
        dispatch_finished_at=now(),error=$2 WHERE id=$1 AND processed_at IS NULL`, [ev.id, String(error.message).slice(0, 500)]);
      console.error(`[chatwoot-dispatcher] event ${ev.id}:`, error.message);
    }
  }
  return summary;
}
