import { parseEvent } from '../attendance/policy.js';
import { ingest, processEvents } from './engine.js';

const ok = reason => ({forwarded:true, attendanceDirect:true, reason});

export async function handleInboundEvent(ev) {
  const m = parseEvent(ev.payload);
  if (!m) return ok('not_message');
  if (!m.incoming) return ok('non_incoming');
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
