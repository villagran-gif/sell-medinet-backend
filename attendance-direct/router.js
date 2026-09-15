import { Router, raw } from 'express';
import { validSignature, parseWebhook, TRIAL_PHONE, metaConfig } from './meta.js';
import { ingest, ensure, request, sendReconciledCompletion } from './engine.js';
import { getPool } from '../chatwoot-webhook/db.js';
import { requireBearer } from '../confirmations/lib/auth.js';
import { readAppointment } from '../attendance/clients.js';
import { eligible, future } from '../attendance/policy.js';
import { backfillChatwootContexts } from './chatwoot-bridge.js';
export function webhookRouter({pool=getPool,env=process.env}={}) {
  const r=Router();
  r.get('/',(req,res)=>{
    if(!env.ATTENDANCE_META_VERIFY_TOKEN || req.query['hub.mode']!=='subscribe' || req.query['hub.verify_token']!==env.ATTENDANCE_META_VERIFY_TOKEN)return res.sendStatus(403);
    res.type('text/plain').send(String(req.query['hub.challenge']||''));
  });
  r.post('/',raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    if(!validSignature(req.body,req.get('x-hub-signature-256'),metaConfig(env).appSecret))return res.sendStatus(403);
    let events;try{events=parseWebhook(JSON.parse(req.body.toString('utf8')));}catch{return res.sendStatus(400);}
    try{await ingest(events,pool());res.sendStatus(200);}catch{return res.sendStatus(503);}
  });return r;
}
export function operatorRouter() {
  const r=Router();r.use(requireBearer);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const route=fn=>async(req,res)=>{try{await ensure();res.json(await fn(req));}catch(e){res.status(409).json({error:e.message});}};
  r.get('/review',route(async req=>{
    const date=String(req.query.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('date_required');
    await backfillChatwootContexts({date}).catch(e=>console.error('[attendance-direct/chatwoot-backfill-review]',e.message));
    const result=await getPool().query(`SELECT r.id,r.snapshot->>'patient' AS patient,r.snapshot->>'professional' AS professional,r.snapshot->>'branch' AS branch,r.snapshot->>'date' AS date,r.snapshot->>'time' AS time,r.phone,r.trial,r.state,r.delivery,r.reply,r.intent,r.medinet_status,r.verified_at,r.error,r.chatwoot_conversation_id,
      COALESCE(r.chatwoot_conversation_id,(SELECT NULLIF(e.payload->'conversation'->>'id','')::bigint FROM chatwoot.raw_events e
       WHERE e.event_type='message_created'
         AND regexp_replace(coalesce(e.payload->'sender'->>'phone_number',''),'\\D','','g')=r.phone
         AND (e.received_at AT TIME ZONE 'America/Santiago')::date=$1::date
       ORDER BY e.received_at DESC LIMIT 1)) AS chatwoot_conversation_id
      FROM attendance_direct.requests r WHERE r.snapshot->>'date'=$1 ORDER BY r.snapshot->>'time',r.id LIMIT 501`,[date]);
    const attention=await getPool().query(`SELECT phone,state,payload->>'text' AS reply,created_at FROM attendance_direct.events WHERE state IN ('needs_review','human_paused') AND (created_at AT TIME ZONE 'America/Santiago')::date=$1::date ORDER BY created_at DESC LIMIT 100`,[date]);
    const testSend=process.env.ATTENDANCE_DIRECT_MODE!=='live'&&process.env.ATTENDANCE_DIRECT_TEST_SEND_ENABLED==='true';
    const directVerified=process.env.ATTENDANCE_DIRECT_CUTOVER_VERIFIED==='true';
    const bridgeVerified=process.env.ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_ENABLED==='true'&&process.env.ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_VERIFIED==='true';
    const liveSend=process.env.ATTENDANCE_DIRECT_SEND_ENABLED==='true'&&(directVerified||bridgeVerified);
    return {mode:process.env.ATTENDANCE_DIRECT_MODE==='live'?'live':'test',sendsEnabled:testSend||liveSend,inboundMode:directVerified?'meta_direct':bridgeVerified?'chatwoot_bridge':'unverified',items:result.rows.slice(0,500),truncated:result.rows.length>500,attention:attention.rows};
  }));
  r.post('/completion',route(async req=>sendReconciledCompletion(req.body?.externalId)));
  r.post('/trial',route(async req=>{
    const date=String(req.body?.date||'');const time=String(req.body?.time||'17:30');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isFinite(Date.parse(date))||!future({date,time}))throw Error('future_date_required');
    const scenario=req.body?.scenario||{};
    const a={id:Number(scenario.id||990000001),phone:TRIAL_PHONE,patient:String(scenario.patient||'Rodrigo'),professionalId:Number(scenario.professionalId||1),professional:String(scenario.professional||'Profesional de prueba'),branchId:Number(scenario.branchId||1),branch:String(scenario.branch||'Prueba'),type:String(scenario.type||'PRUEBA, sin cita real'),date,time};
    return request(a,{trial:true,replaceTrial:true,key:req.body?.key,actor:req.body?.actor||'operator'});
  }));
  r.post('/send',route(async req=>{
    const id=req.body?.appointmentId;if(!Number.isSafeInteger(id)||id<1)throw Error('appointment_id_required');
    const a=await readAppointment(id);if(!eligible(a))throw Error('appointment_ineligible');
    if(req.body?.commit!==true)return {preview:true,appointment:a};
    if(req.body?.fingerprint!==a.fingerprint)throw Error('preview_changed');
    return request(a,{key:`appointment-${a.id}-${a.fingerprint}`,actor:req.body?.actor||'operator'});
  }));
  return r;
}
