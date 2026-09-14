import { parseEvent } from '../attendance/policy.js';
import { ingest, processEvents } from './engine.js';
import { getPool } from '../chatwoot-webhook/db.js';
import { TRIAL_PHONE } from './meta.js';

const ok = reason => ({forwarded:true, attendanceDirect:true, reason});

export async function handleInboundEvent(ev) {
  const m = parseEvent(ev.payload);
  if (!m) return ok('not_message');
  if (!m.incoming) return ok('non_incoming');
  // Test-only recovery: earlier failed trials may have paused the fixed test phone.
  // Never auto-resume real patients.
  if (process.env.ATTENDANCE_DIRECT_MODE !== 'live' && m.phone === TRIAL_PHONE) {
    await getPool().query(`UPDATE attendance_direct.control SET paused=false,reason='test_resume',updated_at=now() WHERE phone=$1`, [m.phone]);
  }
  const event = {
    id: `cw:${m.id}`,
    phone: m.phone,
    kind: 'message',
    at: m.createdAt.valueOf(),
    text: m.text,
    replyTo: null
  };
  await ingest([event]);
  await processEvents();
  return ok('processed');
}
