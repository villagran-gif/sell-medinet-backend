import { Router, raw } from 'express';
import { validSignature, parseWebhook, TRIAL_PHONE, metaConfig } from './meta.js';
import { ingest, ensure, request, sendReconciledCompletion } from './engine.js';
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
    if(!validSignature(req.body,req.get('x-hub-signature-256'),metaConfig(env).appSecret))return res.sendStatus(403);
    let events;try{events=parseWebhook(JSON.parse(req.body.toString('utf8')));}catch{return res.sendStatus(400);}
    try{await ingest(events,pool());res.sendStatus(200);}catch{return res.sendStatus(503);}
  });return r;
}

export function conversationText(body={}) {
  if(body?.type==='text') return String(body?.text?.body||'').trim();
  if(body?.type==='template') {
    const params=(body?.template?.components||[]).flatMap(c=>c?.parameters||[]).map(p=>String(p?.text||'').trim()).filter(Boolean);
    if(body?.template?.name==='cly_confirm_appointment_v1'&&params.length>=5)
      return `Hola ${params[0]}, soy MelanIA de Clínyco 👋. Te confirmamos tu cita de ${params[1]} con ${params[2]} el ${params[3]} a las ${params[4]}. ¿CONFIRMAS? Responde SÍ para confirmar, NO para cancelar, o REAGENDAR si quieres cambiarla.`;
    return `Plantilla WhatsApp: ${body?.template?.name||'sin nombre'}${params.length?`\n${params.join(' · ')}`:''}`;
  }
  if(body?.type==='interactive') {
    const text=String(body?.interactive?.body?.text||'').trim();
    const rows=(body?.interactive?.action?.sections||[]).flatMap(s=>s?.rows||[]).map(r=>`${r?.title||''}${r?.description?` — ${r.description}`:''}`).filter(Boolean);
    return `${text}${rows.length?`\n${rows.map(r=>`• ${r}`).join('\n')}`:''}`.trim();
  }
  return 'Mensaje de WhatsApp';
}

export function operatorRouter() {
  const r=Router();r.use(requireBearer);r.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  const route=fn=>async(req,res)=>{try{await ensure();res.json(await fn(req));}catch(e){res.status(409).json({error:e.message});}};
  r.get('/review',route(async req=>{
    const date=String(req.query.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('date_required');
    const result=await getPool().query(`SELECT id,snapshot->>'patient' AS patient,snapshot->>'professional' AS professional,snapshot->>'branch' AS branch,snapshot->>'date' AS date,snapshot->>'time' AS time,phone,trial,state,delivery,reply,intent,medinet_status,verified_at,error FROM attendance_direct.requests WHERE snapshot->>'date'=$1 ORDER BY snapshot->>'time',id LIMIT 501`,[date]);
    const attention=await getPool().query(`SELECT phone,state,payload->>'text' AS reply,created_at FROM attendance_direct.events WHERE state IN ('needs_review','human_paused') AND (created_at AT TIME ZONE 'America/Santiago')::date=$1::date ORDER BY created_at DESC LIMIT 100`,[date]);
    const testSend=process.env.ATTENDANCE_DIRECT_MODE!=='live'&&process.env.ATTENDANCE_DIRECT_TEST_SEND_ENABLED==='true';
    const directVerified=process.env.ATTENDANCE_DIRECT_CUTOVER_VERIFIED==='true';
    const bridgeVerified=process.env.ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_ENABLED==='true'&&process.env.ATTENDANCE_DIRECT_CHATWOOT_BRIDGE_VERIFIED==='true';
    const liveSend=process.env.ATTENDANCE_DIRECT_SEND_ENABLED==='true'&&(directVerified||bridgeVerified);
    return {mode:process.env.ATTENDANCE_DIRECT_MODE==='live'?'live':'test',sendsEnabled:testSend||liveSend,inboundMode:directVerified?'meta_direct':bridgeVerified?'chatwoot_bridge':'unverified',items:result.rows.slice(0,500),truncated:result.rows.length>500,attention:attention.rows};
  }));
  r.get('/conversation',route(async req=>{
    const requestId=Number(req.query.requestId);if(!Number.isSafeInteger(requestId)||requestId<1)throw Error('request_id_required');
    const pool=getPool();
    const q=await pool.query(`SELECT id,phone,snapshot,trial,state,delivery,reply,intent,medinet_status,verified_at,error,created_at,expires_at FROM attendance_direct.requests WHERE id=$1`,[requestId]);
    const item=q.rows[0];if(!item)throw Error('request_not_found');
    const date=String(item.snapshot?.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('request_date_invalid');
    const [events,outbox]=await Promise.all([
      pool.query(`SELECT id,state,payload,created_at FROM attendance_direct.events WHERE phone=$1 AND (created_at AT TIME ZONE 'America/Santiago')::date=$2::date ORDER BY created_at,id LIMIT 500`,[item.phone,date]),
      pool.query(`SELECT id,state,message_id,body,created_at FROM attendance_direct.outbox WHERE phone=$1 AND (created_at AT TIME ZONE 'America/Santiago')::date=$2::date ORDER BY created_at,id LIMIT 500`,[item.phone,date])
    ]);
    const timeline=[];
    for(const m of outbox.rows)timeline.push({kind:'outbound',id:m.id,at:m.created_at,state:m.state,messageId:m.message_id||null,text:conversationText(m.body)});
    for(const e of events.rows){const p=e.payload||{};if(p.kind==='message')timeline.push({kind:'inbound',id:e.id,at:Number.isFinite(Number(p.at))?new Date(Number(p.at)).toISOString():e.created_at,state:e.state,text:String(p.text||'')});else if(p.kind==='status')timeline.push({kind:'status',id:e.id,at:Number.isFinite(Number(p.at))?new Date(Number(p.at)).toISOString():e.created_at,state:e.state,text:`WhatsApp: ${String(p.status||'actualizado')}`});}
    if(item.verified_at)timeline.push({kind:'system',id:`medinet:${item.id}`,at:item.verified_at,state:item.state,text:`Medinet: ${item.medinet_status||item.state}`});
    timeline.sort((a,b)=>new Date(a.at)-new Date(b.at)||String(a.id).localeCompare(String(b.id)));
    return {request:{id:item.id,phone:item.phone,snapshot:item.snapshot,trial:item.trial,state:item.state,delivery:item.delivery,reply:item.reply,intent:item.intent,medinetStatus:item.medinet_status,verifiedAt:item.verified_at,error:item.error},timeline};
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
