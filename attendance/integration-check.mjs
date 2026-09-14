// Isolated PostgreSQL/WASM validation; no network and no real recipients.

import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {handleInboundEvent} from './engine.js';
const native=!!process.env.ATTENDANCE_TEST_DATABASE_URL;
const db=native ? new (await import('pg')).default.Pool({connectionString:process.env.ATTENDANCE_TEST_DATABASE_URL}) : new (await import(process.env.PGLITE_MODULE || '@electric-sql/pglite')).PGlite();
if(native){db.exec=sql=>db.query(sql);db.close=()=>db.end();}
const pool=native?db:{query:async(sql,args)=>sql.includes('CREATE SCHEMA')?db.exec(sql):db.query(sql,args),connect:async()=>({query:async(sql,args)=>sql.includes('pg_advisory_')?{rows:[]}:db.query(sql,args),release(){}})};
let writes=0,acks=[],handoffs=0;
const now=new Date();const expires=new Date(now.valueOf()+86400000);const sent=new Date(now.valueOf()-5000);
const snapshot={id:10,fingerprint:'verified',date:new Date(now.valueOf()+86400000).toISOString().slice(0,10),time:'23:00',status:'agendado',patient:'Real'};
const client={verifyConversation:async()=>({}),readAppointment:async()=>snapshot,
 writeAppointment:async()=>{writes++;return {...snapshot,status:'confirmado'};},send:async(_id,text)=>{acks.push(text);return{id:900+acks.length};},handoff:async()=>{handoffs++;},cw:async()=>({})};
const event=(id,text)=>({payload:{event:'message_created',account:{id:162472},conversation:{id:50,inbox_id:107690},id,message_type:'incoming',created_at:now.toISOString(),content:text,sender:{phone_number:'+56911111111'}}});
try{
 const schema=await readFile(new URL('./schema.sql',import.meta.url),'utf8');await db.exec(schema);await db.exec(schema);
 await db.query(`INSERT INTO attendance.requests(appointment_id,fingerprint,snapshot,phone,conversation_id,message_id,state,sent_at,expires_at) VALUES(10,'verified',$1,'56911111111',50,100,'pending',$2,$3)`,[JSON.stringify(snapshot),sent,expires]);
 assert.equal((await handleInboundEvent(event(200,'Si'),{pool,client,now})).reason,'completed');assert.equal(writes,1);assert.match(acks[0],/confirmada/);
 await Promise.all([handleInboundEvent(event(200,'Si'),{pool,client,now}),handleInboundEvent(event(200,'Si'),{pool,client,now})]);assert.equal(writes,1);assert.equal(acks.length,1);
 await handleInboundEvent(event(201,'Reagendar'),{pool,client,now});assert.equal(writes,1);assert.equal(handoffs,1);
 await handleInboundEvent(event(202,'Si'),{pool,client,now});assert.equal(writes,1);assert.equal(acks.length,2);
 await db.exec('TRUNCATE attendance.events,attendance.requests,attendance.control RESTART IDENTITY');
 await db.query(`INSERT INTO attendance.requests(appointment_id,fingerprint,snapshot,phone,conversation_id,message_id,state,sent_at,expires_at) VALUES(10,'verified',$1,'56911111111',50,100,'pending',$2,$3)`,[JSON.stringify(snapshot),sent,expires]);
 client.writeAppointment=async()=>{writes++;throw new Error('timeout');};
 await assert.rejects(handleInboundEvent(event(203,'Si'),{pool,client,now}),/needs_review/);
 assert.equal((await db.query('SELECT state FROM attendance.requests')).rows[0].state,'uncertain');
 await handleInboundEvent(event(203,'Si'),{pool,client,now});assert.equal(writes,2);
 console.log('PASS: schema twice, SQL handler confirm + readback, duplicate delivery, contradictory reply, persistent human pause, timeout without replay. Native PostgreSQL:',native);
}finally{await db.close();}
