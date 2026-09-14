import { Router, raw } from 'express';
import { validSignature, parseWebhook, TRIAL_PHONE } from './meta.js';
import { ingest, ensure, request } from './engine.js';
import { getPool } from '../chatwoot-webhook/db.js';
import { requireBearer } from '../confirmations/lib/auth.js';
import { readAppointment } from '../attendance/clients.js';
import { eligible, future } from '../attendance/policy.js';
export function webhookRouter({pool=getPool,env=process.env}={}) {
  const r=Router();
  r.get('/',(req,res)=>{
    if(!env.ATTENDANCE_META_VERIFY_TOKEN || req.query['hub.mode']!=='subscribe' || req.query['hub.verify_token']!==env.ATTENDANCE_META_VERIFY_TOKEN)return res.sendStatus(403);
    res.type('text/plain').send(String(req.query['hub.challenge']||''));
  });
  r.post('/',raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    if(!validSignature(req.body,req.get('x-hub-signature-256'),env.ATTENDANCE_META_APP_SECRET))return res.sendStatus(403);
    let events;try{events=parseWebhook(JSON.parse(req.body.toString('utf8')));}catch{return res.sendStatus(400);}
    try{await ingest(events,pool());res.sendStatus(200);}catch{res.sendStatus(503);}
  });return r;
}
export function operatorRouter() {
  const r=Router();r.use(requireBearer);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const route=fn=>async(req,res)=>{try{await ensure();res.json(await fn(req));}catch(e){res.status(409).json({error:e.message});}};
  r.get('/review',route(async req=>{
    const date=String(req.query.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('date_required');
    const result=await getPool().query(`SELECT id,snapshot->>'patient' AS patient,snapshot->>'professional' AS professional,snapshot->>'branch' AS branch,snapshot->>'date' AS date,snapshot->>'time' AS time,phone,trial,state,delivery,reply,intent,medinet_status,verified_at,error FROM attendance_direct.requests WHERE snapshot->>'date'=$1 ORDER BY snapshot->>'time',id LIMIT 501`,[date]);
    const attention=await getPool().query(`SELECT phone,state,payload->>'text' AS reply,created_at FROM attendance_direct.events WHERE state IN ('needs_review','human_paused') AND (created_at AT TIME ZONE 'America/Santiago')::date=$1::date ORDER BY created_at DESC LIMIT 100`,[date]);
    return {mode:process.env.ATTENDANCE_DIRECT_MODE==='live'?'live':'test',sendsEnabled:process.env.ATTENDANCE_DIRECT_SEND_ENABLED==='true'&&process.env.ATTENDANCE_DIRECT_CUTOVER_VERIFIED==='true',items:result.rows.slice(0,500),truncated:result.rows.length>500,attention:attention.rows};
  }));
  r.post('/trial',route(async req=>{
    const date=String(req.body?.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||!future({date,time:'17:30'}))throw Error('future_date_required');
    return request({phone:TRIAL_PHONE,patient:'Rodrigo',professional:'Profesional de prueba',date,time:'17:30',branch:'Prueba'}, {trial:true,key:req.body?.key,actor:req.body?.actor||'operator'});
  }));
  r.post('/send',route(async req=>{
    const id=req.body?.appointmentId;if(!Number.isSafeInteger(id)||id<1)throw Error('appointment_id_required');
    const a=await readAppointment(id);if(!eligible(a))throw Error('appointment_ineligible');
    if(req.body?.commit!==true)return {preview:true,appointment:a};
    // Recheck fingerprint approved by the operator; one appointment per request.
    if(req.body?.fingerprint!==a.fingerprint)throw Error('preview_changed');
    return request(a,{key:`appointment-${a.id}-${a.fingerprint}`,actor:req.body?.actor||'operator'});
  }));
  return r;
}
