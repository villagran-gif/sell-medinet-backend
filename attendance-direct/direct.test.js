import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {validSignature,parseWebhook,PHONE_ID,sendMeta,template,TRIAL_PHONE} from './meta.js';
import {selectRequest,sendReconciledCompletion} from './engine.js';
test('HMAC requires exact raw bytes and secret',()=>{
  const raw=Buffer.from('{"object":"whatsapp_business_account"}');const sig='sha256='+createHmac('sha256','synthetic').update(raw).digest('hex');
  assert.equal(validSignature(raw,sig,'synthetic'),true);assert.equal(validSignature(Buffer.from('{}'),sig,'synthetic'),false);assert.equal(validSignature(raw,sig,''),false);assert.equal(validSignature(raw,'sha256=bad','synthetic'),false);
});
test('dedicated phone only, records Meta text IDs and quoted replies',()=>{
  const value={metadata:{phone_number_id:PHONE_ID},messages:[{id:'wamid.synthetic',from:TRIAL_PHONE,timestamp:'1800000000',text:{body:'sí'},context:{id:'wamid.out'}}]};
  const body={object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value}]}]};
  assert.deepEqual(parseWebhook(body)[0],{id:'wamid.synthetic',phone:TRIAL_PHONE,kind:'message',at:1800000000000,text:'sí',replyTo:'wamid.out'});
  value.metadata.phone_number_id='another-phone';assert.deepEqual(parseWebhook(body),[]);
});
test('unquoted reply cannot choose between appointments, quoted sender must match',()=>{
 const now=new Date('2026-09-14T13:00:00Z');const a={phone:TRIAL_PHONE,created_at:'2026-09-14T12:00:00Z',expires_at:'2026-09-15T12:00:00Z',message_id:'one'};
 const e={phone:TRIAL_PHONE,at:now.valueOf(),replyTo:null};
 assert.equal(selectRequest([a],e,now),a);assert.equal(selectRequest([a,{...a,message_id:'two'}],e,now),null);
 assert.equal(selectRequest([a],{...e,phone:'56911111111',replyTo:'one'},now),null);
 assert.equal(selectRequest([a],{...e,replyTo:'unknown'},now),null);
 assert.equal(selectRequest([a],{...e,at:Date.parse('2026-09-13')},now),null);
});
test('direct Meta send locked until cutover and trial restricted',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return {ok:true,json:async()=>({messages:[{id:'wamid.test'}]})};};
 const env={ATTENDANCE_DIRECT_SEND_ENABLED:'true',ATTENDANCE_META_TOKEN:'synthetic',ATTENDANCE_META_VERSION:'v23.0'};
 await assert.rejects(sendMeta(TRIAL_PHONE,{}, {env,fetchImpl}),/cutover/);
 env.ATTENDANCE_DIRECT_CUTOVER_VERIFIED='true';await assert.rejects(sendMeta('56911111111',{}, {env,fetchImpl}),/trial_recipient/);assert.equal(calls,0);
 assert.equal(await sendMeta(TRIAL_PHONE,{}, {env,fetchImpl}),'wamid.test');assert.equal(calls,1);
});
test('provider error never counts as sent',async()=>{
 const env={ATTENDANCE_DIRECT_SEND_ENABLED:'true',ATTENDANCE_DIRECT_CUTOVER_VERIFIED:'true',ATTENDANCE_META_TOKEN:'synthetic',ATTENDANCE_META_VERSION:'v23.0'};
 await assert.rejects(sendMeta(TRIAL_PHONE,{}, {env,fetchImpl:async()=>({ok:false,status:403,json:async()=>({})})}),/unverified/);
});
test('trial template explicitly indicates no real appointment',()=>{
 const b=template({professional:'Test',date:'2026-09-15',time:'17:30'},true);
 assert.equal(b.type,'template');assert.match(b.template.components[0].parameters[1].text,/sin cita real/);
});

test('reconciled completion is verified from DB and sent once',async()=>{
 const outbox=new Map();let sends=0;
 const request={id:2,phone:TRIAL_PHONE,snapshot:{id:990000001,professional:'Rodrigo Villagran Morales',branch:'Antofagasta Mall Arauco Express'},state:'rescheduled',medinet_status:'completed',verified_at:new Date()};
 const session={phone:TRIAL_PHONE,state:'completed',chosen:{date:'21/09/2026',dataDia:'2026-09-21',time:'10:00'},new_appointment_id:421486,original_appointment_id:421423};
 const db={release(){},async query(sql,args=[]){
   if(sql.includes('pg_advisory_lock')||sql.includes('pg_advisory_unlock'))return {rows:[]};
   if(sql.includes("FROM attendance_direct.requests")&&sql.includes("state='rescheduled'"))return {rows:[request]};
   if(sql.includes('FROM melania_reschedule_sessions'))return {rows:[session]};
   if(sql.startsWith('INSERT INTO attendance_direct.outbox')){const id=args[0];if(outbox.has(id))return {rows:[]};outbox.set(id,{state:'pending',message_id:null});return {rows:[{id}]};}
   if(sql.startsWith('UPDATE attendance_direct.outbox')){const [id,mid]=args;outbox.set(id,{state:'accepted',message_id:mid});return {rows:[]};}
   if(sql.startsWith('SELECT state,message_id FROM attendance_direct.outbox'))return {rows:[outbox.get(args[0])]};
   throw Error('unexpected query '+sql);
 }};
 const pool={async query(){return {rows:[]};},async connect(){return db;}};
 const send=async(phone,body)=>{sends++;assert.equal(phone,TRIAL_PHONE);assert.match(body.text.body,/21\/09\/2026 a las 10:00/);assert.match(body.text.body,/Antofagasta Mall Arauco Express/);return 'wamid.final';};
 const first=await sendReconciledCompletion(990000001,{pool,send});
 assert.equal(first.sent,true);assert.equal(first.duplicate,false);assert.equal(sends,1);
 const second=await sendReconciledCompletion(990000001,{pool,send});
 assert.equal(second.sent,true);assert.equal(second.duplicate,true);assert.equal(sends,1);
});
