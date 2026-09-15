import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ensure,request,ingest,processEvents,sendPendingTwoHourFollowups} from './engine.js';
import {TRIAL_PHONE} from './meta.js';
// Embedded PostgreSQL exercises persisted SQL. Advisory-lock concurrency is a deployment gate.
test('durable direct trial: replies, deduplication, support and no Chatwoot/Medinet effects',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 let sends=0,writes=0;const now=new Date();let later;
 const send=async(phone,body)=>{assert.equal(phone,TRIAL_PHONE);sends++;return `wamid.${sends}`;};
 const a={phone:TRIAL_PHONE,patient:'Synthetic',professional:'Synthetic',date:'2099-01-01',time:'17:30'};
 try {
  await ensure(pool);
  const first=await request(a,{trial:true,key:'trial-synthetic-1',actor:'synthetic',pool,send,now});assert.equal(first.state,'pending');
  assert.equal((await request(a,{trial:true,key:'trial-synthetic-1',actor:'synthetic',pool,send,now})).duplicate,true);assert.equal(sends,1);
  later=new Date(Date.now()+1000);
  const e={id:'in.1',phone:TRIAL_PHONE,kind:'message',at:later.valueOf(),text:'sí',replyTo:'wamid.1'};
  await ingest([e,e],pool);await processEvents({pool,send,now:later,write:async()=>{writes++;}});
  assert.equal(sends,2);assert.equal(writes,0);
  assert.equal((await pool.query('SELECT state FROM attendance_direct.requests')).rows[0].state,'confirm');
  await ingest([e],pool);await processEvents({pool,send,now:later});assert.equal(sends,2);
  await ingest([{...e,id:'in.2',text:'no'}],pool);await processEvents({pool,send,now:later});
  assert.equal((await pool.query('SELECT state FROM attendance_direct.requests')).rows[0].state,'human');
  assert.equal((await pool.query('SELECT paused FROM attendance_direct.control')).rows[0].paused,true);
  const bodies=(await pool.query('SELECT body FROM attendance_direct.outbox ORDER BY created_at')).rows;
  assert.match(bodies.at(-1).body.text.body,/wa.me\/56953386191/);
  await ingest([{...e,id:'in.3',text:'sí'}],pool);await processEvents({pool,send,now:later});assert.equal(sends,3);
  await assert.rejects(request(a,{trial:true,key:'trial-synthetic-2',actor:'synthetic',pool,send,now}),/human_paused/);
 } finally {await db.close();}
});
test('timeout stays uncertain and same idempotency key never sends twice',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 let sends=0;const a={phone:TRIAL_PHONE,patient:'Synthetic',professional:'Synthetic',date:'2099-01-01',time:'17:30'};
 const opts={pool,trial:true,key:'trial-timeout-1',actor:'synthetic',send:async()=>{sends++;throw Error('timeout');}};
 try {await assert.rejects(request(a,opts),/timeout/);const r=await request(a,opts);assert.equal(r.state,'uncertain');assert.equal(sends,1);}finally{await db.close();}
});


test('two-hour no-response follow-up is sent once and remains idempotent',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 let sends=0;const now=new Date('2026-09-15T15:00:00Z');
 try{
  await ensure(pool);
  const snapshot={id:123,phone:'56911111111',patient:'Paciente Test',professional:'Profesional Test',branchId:39,branch:'Sede Test',type:'Consulta',date:'2099-01-01',time:'10:00',fingerprint:'synthetic'};
  await pool.query(`INSERT INTO attendance_direct.requests(request_key,snapshot,phone,trial,actor,state,delivery,created_at,expires_at) VALUES($1,$2,$3,false,'test','pending','accepted',$4,$5)`,['followup-test',JSON.stringify(snapshot),snapshot.phone,new Date(now.valueOf()-3*3600000),new Date(now.valueOf()+24*3600000)]);
  const send=async(phone,body)=>{assert.equal(phone,snapshot.phone);assert.equal(body.type,'template');sends++;return `wamid.followup.${sends}`;};
  const first=await sendPendingTwoHourFollowups({pool,send,now});assert.equal(first.sent,1);assert.equal(sends,1);
  const second=await sendPendingTwoHourFollowups({pool,send,now});assert.equal(second.duplicate,1);assert.equal(sends,1);
 }finally{await db.close();}
});
