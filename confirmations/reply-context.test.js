import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { extractAttendanceReply } from './reply-context.js';
const payload = { account: { id: 162472 }, id: 20, event: 'message_created', message_type: 'incoming', content: 'Sí',
  sender: { phone_number: '+56 9 1111 1111' }, conversation: { id: 11, inbox_id: 110652 },
  content_attributes: { in_reply_to: 10 } };
for (const [name, edit] of Object.entries({
  'unquoted yes': { content_attributes: {} }, 'old inbox': { conversation: { id: 11, inbox_id: 107690 } },
  'wrong account': { account: { id: 123 } }, 'private note': { private: true }, 'delivery update': { event: 'message_updated' },
  'outgoing': { message_type: 'outgoing' }, 'missing type': { message_type: undefined },
  'missing message id': { id: undefined }, 'missing contact': { sender: {} },
})) test(`reply context rejects ${name}`, () => assert.equal(extractAttendanceReply({ ...payload, ...edit }), null));
test('explicit quoted reply retains message and channel identity', () => {
  assert.deepEqual(extractAttendanceReply(payload), { id: '20', replyTo: '10', inboxId: '110652',
    conversationId: '11', phone: '56911111111', content: 'Sí' });
});
const source = readFileSync(new URL('./lifecycle.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
function lifecycle(query) {
  return vm.runInNewContext(source + '\n({findAppointmentByReply, applyIntent})', { getPool: () => ({ query }) });
}
test('multiple matching requests never select the first appointment', async () => {
  const l = lifecycle(async () => ({ rows: [{ id: 1 }, { id: 2 }] }));
  assert.equal(await l.findAppointmentByReply(extractAttendanceReply(payload)), null);
});
test('missing or invalidated request has no matching appointment', async () => {
  const l = lifecycle(async () => ({ rows: [] }));
  assert.equal(await l.findAppointmentByReply(extractAttendanceReply(payload)), null);
});
test('transition requires a revision; stale or duplicate transition returns no receipt', async () => {
  let calls = 0;
  const l = lifecycle(async () => { calls++; return { rows: [] }; });
  assert.equal(await l.applyIntent(1, 'confirm'), null);
  assert.equal(calls, 0);
  assert.equal(await l.applyIntent(1, 'confirm', 2), null);
});
