// Optional isolated PostgreSQL/WASM check. Install @electric-sql/pglite outside
// the service repo; set PGLITE_MODULE to its dist/index.js and run this file.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
try {
  const dir = new URL('./migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  await db.exec(readFileSync(new URL('003_reply_context.sql', dir), 'utf8'));
  const source = readFileSync(new URL('./lifecycle.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
  const api = vm.runInNewContext(source + '\n({findAppointmentByReply,applyIntent})', { getPool: () => db });
  await db.exec(`INSERT INTO confirmations.appointments(external_id,branch_id,appointment_at,patient_phone,raw,state,medinet_state,chatwoot_conversation_id)
    VALUES(10,39,now()+interval '10 days','+56911111111','{}','first_msg_sent','Agendado',11),
          (20,39,now()+interval '11 days','+56911111111','{}','first_msg_sent','Agendado',11);
    INSERT INTO confirmations.outbound_messages(appointment_id,template_name,chatwoot_message_id,appointment_revision,chatwoot_conversation_id,chatwoot_inbox_id)
    VALUES(1,'initial',100,1,11,110652),(2,'initial',200,1,11,110652);`);
  const msg = { phone:'56911111111',conversationId:11,inboxId:110652,replyTo:200 };
  assert.equal(Number((await api.findAppointmentByReply(msg)).id),2);
  assert.equal(await api.findAppointmentByReply({...msg,conversationId:12}),null);
  await db.exec("UPDATE confirmations.appointments SET appointment_at=appointment_at+interval '1 hour' WHERE id=2");
  assert.equal(await api.findAppointmentByReply(msg),null);
  assert.equal(await api.applyIntent(2,'confirm',1),null);
  assert.equal((await api.applyIntent(1,'confirm',1)).state,'confirmed');
  assert.equal(await api.applyIntent(1,'confirm',1),null);
  await db.exec("UPDATE confirmations.appointments SET state='first_msg_sent',medinet_state='Cancelada' WHERE id=1");
  assert.equal(await api.findAppointmentByReply({...msg,replyTo:100}),null);
  assert.equal(await api.applyIntent(1,'confirm',2),null);
  await db.exec("UPDATE confirmations.appointments SET medinet_state='Agendado',appointment_at=now()-interval '1 hour' WHERE id=1");
  assert.equal(await api.applyIntent(1,'confirm',3),null);
  console.log('PASS: migrations twice; exact appointment among two; wrong conversation; changed revision; repeated transition; cancelled and past appointment');
} finally { await db.close(); }
