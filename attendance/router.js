import { Router } from 'express';
import { requireBearer } from '../confirmations/lib/auth.js';
import { getPool } from '../chatwoot-webhook/db.js';
import { ensure, sendRequest, tick, locked } from './engine.js';
import { readAppointment } from './clients.js';
import { eligible } from './policy.js';
export function attendanceRouter() {
  const r=Router();r.use(requireBearer);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const route=fn=>async(req,res)=>{try{await ensure();res.json(await fn(req));}catch(e){console.error('[attendance]',e.message);res.status(409).json({error:e.message});}};
  r.get('/health',route(async()=>({enabled:process.env.ATTENDANCE_ENABLED==='true',sends:process.env.ATTENDANCE_LIVE_SEND_ENABLED==='true',medinetWrites:process.env.ATTENDANCE_MEDINET_WRITE_ENABLED==='true'})));
  r.post('/trial',route(async req=>{
    const key=req.body?.idempotencyKey;if(typeof key!=='string'||!/^trial-[a-zA-Z0-9-]{8,80}$/.test(key))throw new Error('trial_idempotency_key_required');
    return sendRequest({phone:'56987297033',patient:'Rodrigo',professional:'Profesional de prueba',date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'17:30',fingerprint:key},{trial:true});}));
  // Only explicit IDs, never a general scan or unbounded activation. Read-only preview by default.
  r.post('/batch',route(async req=>{
    const {appointmentIds,professionalId,sendAt,commit=false}=req.body||{};
    if(!Array.isArray(appointmentIds)||!appointmentIds.length||appointmentIds.length>20||!appointmentIds.every(x=>Number.isSafeInteger(x)&&x>0)
      ||!Number.isSafeInteger(professionalId)||professionalId<1)throw new Error('invalid_pilot');
    const when=new Date(sendAt);if(!Number.isFinite(when.valueOf())||when<=new Date())throw new Error('future_send_time_required');
    const rows=await Promise.all([...new Set(appointmentIds)].map(readAppointment));
    if(rows.some(a=>a.professionalId!==professionalId||!eligible(a,when)))throw new Error('ineligible_appointment');
    if(commit){const db=await getPool().connect();try{await db.query('BEGIN');for(const a of rows)await db.query(`INSERT INTO attendance.jobs(appointment_id,professional_id,fingerprint,send_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[a.id,professionalId,a.fingerprint,when]);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}}
    return {committed:commit,sendAt:when,appointments:rows};
  }));
  r.post('/tick',route(()=>tick()));
  r.get('/review',route(async()=>({requests:(await getPool().query("SELECT id,appointment_id,conversation_id,state,trial,verified_at FROM attendance.requests ORDER BY id DESC LIMIT 100")).rows,jobs:(await getPool().query('SELECT * FROM attendance.jobs ORDER BY id DESC LIMIT 100')).rows})));
  r.post('/pause',route(async req=>{
    const id=Number(req.body?.conversationId);if(!Number.isSafeInteger(id)||id<1)throw new Error('invalid_conversation');
    await locked(getPool(),id,db=>db.query(`INSERT INTO attendance.control(conversation_id,paused,reason) VALUES($1,true,'operator') ON CONFLICT(conversation_id) DO UPDATE SET paused=true,reason='operator',updated_at=now()`,[id]));return {paused:true};
  }));
  // Resume never replays past messages or clears unresolved request state.
  r.post('/resume',route(async req=>{
    const id=Number(req.body?.conversationId);if(!Number.isSafeInteger(id)||id<1)throw new Error('invalid_conversation');
    await locked(getPool(),id,db=>db.query('UPDATE attendance.control SET paused=false,reason=$2,updated_at=now() WHERE conversation_id=$1',[id,'operator_resume']));return {resumed:true};
  }));
  return r;
}
