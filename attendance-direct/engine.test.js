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

test('two-hour follow-up respects Chile quiet hours and waits until morning',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 try{await ensure(pool);let sends=0;const night=new Date('2026-09-16T01:30:00Z');const r=await sendPendingTwoHourFollowups({pool,send:async()=>{sends++;return 'wamid.q';},now:night});assert.equal(r.quietHours,true);assert.equal(sends,0);}finally{await db.close();}
});

test('past appointment human pause is released for a new future confirmation',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 const priorMode=process.env.ATTENDANCE_DIRECT_MODE;process.env.ATTENDANCE_DIRECT_MODE='live';
 const now=new Date('2026-09-16T01:00:00Z'),phone='56937436528';
 const oldSnap={id:421477,phone,patient:'Hector',professional:'Rodrigo',date:'2026-09-15',time:'16:20',type:'Consulta',branchId:39,branch:'Sede',status:'agendado',fingerprint:'old'};
 const next={id:421535,phone,patient:'Hector',professional:'Rodrigo',date:'2026-09-16',time:'16:00',type:'Consulta',branchId:39,branch:'Sede',status:'agendado',fingerprint:'next'};
 try{
  await ensure(pool);
  await pool.query(`INSERT INTO attendance_direct.requests(request_key,snapshot,phone,trial,actor,state,delivery,expires_at) VALUES('old-human',$1,$2,false,'test','pending','accepted',$3)`,[JSON.stringify(oldSnap),phone,new Date(now.valueOf()+24*3600000)]);
  await pool.query(`INSERT INTO attendance_direct.control(phone,paused,reason) VALUES($1,true,'human')`,[phone]);
  const r=await request(next,{pool,trial:false,key:'future-after-past',actor:'test',now,read:async()=>next,send:async()=> 'wamid.new'});
  assert.equal(r.state,'pending');
  const old=(await pool.query(`SELECT state,expires_at FROM attendance_direct.requests WHERE request_key='old-human'`)).rows[0];assert.equal(old.state,'external_closed');assert.ok(new Date(old.expires_at)<=now);
  const ctl=(await pool.query('SELECT paused,reason FROM attendance_direct.control WHERE phone=$1',[phone])).rows[0];assert.equal(ctl.paused,false);assert.equal(ctl.reason,'past_appointment_released');
 }finally{if(priorMode===undefined)delete process.env.ATTENDANCE_DIRECT_MODE;else process.env.ATTENDANCE_DIRECT_MODE=priorMode;await db.close();}
});

test('same appointment fingerprint is idempotent even when batch key changes',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 const priorMode=process.env.ATTENDANCE_DIRECT_MODE;process.env.ATTENDANCE_DIRECT_MODE='live';
 const now=new Date('2026-09-16T01:00:00Z'),a={id:9001,phone:'56911111111',patient:'Paciente',professional:'Profesional',date:'2026-09-16',time:'15:00',type:'Consulta',branchId:39,branch:'Sede',status:'agendado',fingerprint:'fp-9001'};let sends=0;
 try{await ensure(pool);const opts={pool,trial:false,actor:'test',now,read:async()=>a,send:async()=>{sends++;return `wamid.${sends}`;}};
  await request(a,{...opts,key:'batch-key-one'});await pool.query(`UPDATE attendance_direct.requests SET state='confirm',expires_at=$1 WHERE snapshot->>'id'='9001'`,[now]);
  const again=await request(a,{...opts,key:'batch-key-two'});assert.equal(again.duplicate,true);assert.equal(sends,1);
 }finally{if(priorMode===undefined)delete process.env.ATTENDANCE_DIRECT_MODE;else process.env.ATTENDANCE_DIRECT_MODE=priorMode;await db.close();}
});

test('new request reconciles later duplicate pending rows from prior batch restarts',async()=>{
 const db=new PGlite();const pool={query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:args?db.query(sql,args):sql.includes('CREATE SCHEMA')?(await db.exec(sql),{rows:[]}):db.query(sql),connect:async()=>({...pool,release(){}})};
 const priorMode=process.env.ATTENDANCE_DIRECT_MODE;process.env.ATTENDANCE_DIRECT_MODE='live';const now=new Date('2026-09-16T01:00:00Z');
 const snap={id:8001,phone:'56922222222',patient:'Paciente Uno',professional:'Profesional',date:'2026-09-16',time:'14:00',type:'Consulta',branchId:39,branch:'Sede',status:'agendado',fingerprint:'fp-8001'};
 const next={id:8002,phone:'56933333333',patient:'Paciente Dos',professional:'Profesional',date:'2026-09-16',time:'16:00',type:'Consulta',branchId:39,branch:'Sede',status:'agendado',fingerprint:'fp-8002'};
 try{await ensure(pool);await pool.query(`INSERT INTO attendance_direct.requests(request_key,snapshot,phone,trial,actor,state,delivery,created_at,expires_at) VALUES('dup-old',$1,$2,false,'test','confirm','accepted',$3,$4),('dup-new',$1,$2,false,'test','pending','accepted',$5,$6)`,[JSON.stringify(snap),snap.phone,new Date(now.valueOf()-3600000),now,new Date(now.valueOf()-1800000),new Date(now.valueOf()+86400000)]);
  await request(next,{pool,trial:false,key:'cleanup-trigger',actor:'test',now,read:async()=>next,send:async()=> 'wamid.next'});
  const rows=(await pool.query(`SELECT request_key,state FROM attendance_direct.requests WHERE request_key IN ('dup-old','dup-new') ORDER BY request_key`)).rows;assert.equal(rows.find(r=>r.request_key==='dup-old').state,'confirm');assert.equal(rows.find(r=>r.request_key==='dup-new').state,'external_closed');
 }finally{if(priorMode===undefined)delete process.env.ATTENDANCE_DIRECT_MODE;else process.env.ATTENDANCE_DIRECT_MODE=priorMode;await db.close();}
});
