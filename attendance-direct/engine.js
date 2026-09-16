import { readFile } from 'node:fs/promises';
import { getPool } from '../chatwoot-webhook/db.js';
import { readAppointment, writeAppointment, rescheduleWithMelania } from '../attendance/clients.js';
import { eligible, future, decision, snapshot as normalizeAppointment, norm } from '../attendance/policy.js';
import { classifyInbound } from '../confirmations/classifier.js';
import { sendMeta, template, rescheduleList, rescheduleDateList, rescheduleTimeList, TRIAL_PHONE, supportText } from './meta.js';
import { locationDetails } from './location.js';
const ready=new WeakMap();
export async function ensure(pool=getPool()) {
  if(!ready.has(pool)) ready.set(pool,readFile(new URL('./schema.sql',import.meta.url),'utf8').then(sql=>pool.query(sql)).catch(e=>{ready.delete(pool);throw e;}));
  return ready.get(pool);
}
async function lock(pool,work) {
  await ensure(pool);const db=await pool.connect();
  try {await db.query("SELECT pg_advisory_lock(hashtextextended('attendance_direct',0))");return await work(db);}
  finally {try{await db.query("SELECT pg_advisory_unlock(hashtextextended('attendance_direct',0))");}finally{db.release();}}
}
export function selectRequest(rows,event,now=new Date()) {
  const valid=rows.filter(r=>r.phone===event.phone && new Date(r.created_at).valueOf()<=event.at && new Date(r.expires_at)>now);
  const match=event.replyTo?valid.filter(r=>r.message_id===event.replyTo):valid;
  return match.length===1?match[0]:null;
}
const pause=(db,phone,reason)=>db.query(`INSERT INTO attendance_direct.control(phone,paused,reason) VALUES($1,true,$2) ON CONFLICT(phone) DO UPDATE SET paused=true,reason=$2,updated_at=now()`,[phone,reason]);
async function sendOnce(db,id,phone,body,send) {
  const claim=await db.query('INSERT INTO attendance_direct.outbox(id,phone,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[id,phone,JSON.stringify(body)]);
  if(!claim.rows.length) return null;
  try {const mid=await send(phone,body);await db.query("UPDATE attendance_direct.outbox SET state='accepted',message_id=$2 WHERE id=$1",[id,mid]);return mid;}
  catch(e){await db.query("UPDATE attendance_direct.outbox SET state='uncertain' WHERE id=$1",[id]);throw e;}
}
export async function request(a,{trial=false,replaceTrial=false,key,actor,pool=getPool(),send=sendMeta,read=readAppointment,now=new Date()}={}) {
  if(!actor || !key || !/^[a-zA-Z0-9_-]{8,100}$/.test(key))throw Error('request_identity_required');
  if(trial && a.phone!==TRIAL_PHONE)throw Error('trial_recipient_only');
  if(!trial && process.env.ATTENDANCE_DIRECT_MODE!=='live')throw Error('direct_test_mode');
  return lock(pool,async db=>{
    await db.query(`WITH ranked AS (
      SELECT id,row_number() OVER (PARTITION BY snapshot->>'id',snapshot->>'fingerprint',trial ORDER BY created_at,id) rn
      FROM attendance_direct.requests
      WHERE trial=false AND snapshot ? 'id' AND snapshot ? 'fingerprint')
      UPDATE attendance_direct.requests r SET state='external_closed',expires_at=now(),medinet_status=COALESCE(medinet_status,'duplicate_request')
      FROM ranked d WHERE r.id=d.id AND d.rn>1 AND r.state IN ('pending','sending','processing')`);
    const prior=await db.query('SELECT id,state FROM attendance_direct.requests WHERE request_key=$1',[key]);
    if(prior.rows.length)return {...prior.rows[0],duplicate:true};
    if(!trial){
      const same=await db.query(`SELECT id,state FROM attendance_direct.requests WHERE trial=false AND snapshot->>'id'=$1 AND snapshot->>'fingerprint'=$2 ORDER BY created_at,id LIMIT 1`,[String(a.id),String(a.fingerprint||'')]);
      if(same.rows.length)return {...same.rows[0],duplicate:true};
    }
    // An explicit replacement trial may clear only the fixed trial phone's prior pause.
    if(trial&&replaceTrial){
      await db.query(`UPDATE attendance_direct.requests SET expires_at=$2 WHERE phone=$1 AND trial=true AND expires_at>$2`,[a.phone,now]);
      await db.query(`INSERT INTO attendance_direct.control(phone,paused,reason) VALUES($1,false,'trial_replaced') ON CONFLICT(phone) DO UPDATE SET paused=false,reason='trial_replaced',updated_at=now()`,[a.phone]);
    }else {
      const control=(await db.query('SELECT paused,reason FROM attendance_direct.control WHERE phone=$1',[a.phone])).rows[0];
      if(control?.paused){
        if(control.reason!=='human')throw Error('human_paused');
        const stale=(await db.query(`SELECT id,snapshot FROM attendance_direct.requests WHERE phone=$1 AND (expires_at>$2 OR state IN ('sending','uncertain','processing'))`,[a.phone,now])).rows;
        if(stale.some(row=>future(row.snapshot,now)))throw Error('human_paused');
        await db.query(`UPDATE attendance_direct.requests SET expires_at=$2,state=CASE WHEN state IN ('pending','sending','processing') THEN 'external_closed' ELSE state END,medinet_status=COALESCE(medinet_status,'appointment_passed') WHERE phone=$1 AND (expires_at>$2 OR state IN ('sending','uncertain','processing'))`,[a.phone,now]);
        await db.query(`UPDATE attendance_direct.control SET paused=false,reason='past_appointment_released',updated_at=now() WHERE phone=$1`,[a.phone]);
      }
    }
    if(!trial){const fresh=await read(a.id);if(!eligible(fresh,now)||fresh.fingerprint!==a.fingerprint)throw Error('appointment_changed');}
    // One unresolved request per phone: an unquoted reply must never target the wrong appointment.
    const active=await db.query(`SELECT id FROM attendance_direct.requests WHERE phone=$1 AND (expires_at>$2 OR state IN ('sending','uncertain','processing'))`,[a.phone,now]);
    if(active.rows.length)throw Error('phone_has_current_request');
    const {rows:[r]}=await db.query(`INSERT INTO attendance_direct.requests(request_key,snapshot,phone,trial,actor,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[key,JSON.stringify(a),a.phone,trial,actor,new Date(now.valueOf()+48*3600000)]);
    try {const mid=await sendOnce(db,`request:${r.id}`,a.phone,template(a,trial),send);
      await db.query("UPDATE attendance_direct.requests SET message_id=$2,state='pending',delivery='accepted' WHERE id=$1",[r.id,mid]);return {id:r.id,state:'pending',delivery:'accepted'};
    }catch(e){await db.query("UPDATE attendance_direct.requests SET state='uncertain',error='outbound_unverified' WHERE id=$1",[r.id]);await pause(db,a.phone,'outbound_unverified');throw e;}
  });
}
export async function ingest(events,pool=getPool()) {
  await ensure(pool);const db=await pool.connect();try {await db.query('BEGIN');
    for(const e of events)await db.query('INSERT INTO attendance_direct.events(id,phone,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[e.id,e.phone,JSON.stringify(e)]);
    await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
export async function sendReconciledCompletion(externalId,{pool=getPool(),send=sendMeta}={}) {
  const id=Number(externalId);
  if(!Number.isSafeInteger(id)||id<1)throw Error('external_id_required');
  return lock(pool,async db=>{
    const req=await db.query(`SELECT id,phone,snapshot,state,medinet_status,verified_at FROM attendance_direct.requests
      WHERE snapshot->>'id'=$1 AND state='rescheduled' AND medinet_status='completed'
      ORDER BY verified_at DESC NULLS LAST,id DESC LIMIT 2`,[String(id)]);
    if(req.rows.length!==1)throw Error(req.rows.length?'completed_request_ambiguous':'completed_request_required');
    const r=req.rows[0];
    const ses=await db.query(`SELECT phone,state,chosen,new_appointment_id,original_appointment_id FROM melania_reschedule_sessions WHERE external_id=$1`,[id]);
    const m=ses.rows[0];
    if(!m||m.state!=='completed'||!m.chosen||!m.new_appointment_id||!m.original_appointment_id)throw Error('completed_session_required');
    if(String(m.phone)!==String(r.phone))throw Error('completion_phone_mismatch');
    const chosen=m.chosen||{},snapshot=r.snapshot||{};
    const date=String(chosen.date||'').trim() || String(chosen.dataDia||'').split('-').reverse().join('/');
    const time=String(chosen.time||'').slice(0,5);
    const professional=String(snapshot.professional||'').trim();
    const branch=String(snapshot.branch||'').trim();
    if(!/^\d{2}\/\d{2}\/\d{4}$/.test(date)||!/^\d{2}:\d{2}$/.test(time)||!professional||!branch)throw Error('completion_context_invalid');
    const location=locationDetails(snapshot).text;
    const body={type:'text',text:{body:`Listo. Tu cita quedó reagendada con ${professional} para el ${date} a las ${time} en ${branch}.${location?`\n\n${location}`:''}`}};
    const outboxId=`reconcile-complete:${r.id}:${m.new_appointment_id}`;
    const mid=await sendOnce(db,outboxId,r.phone,body,send);
    const state=(await db.query('SELECT state,message_id FROM attendance_direct.outbox WHERE id=$1',[outboxId])).rows[0];
    return {sent:state?.state==='accepted',duplicate:mid===null,state:state?.state||null,messageId:state?.message_id||null,requestId:r.id,newAppointmentId:Number(m.new_appointment_id)};
  });
}


export function externalStateForMedinetStatus(value) {
  const status=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  if(['cancelada','cancelado','re-agendado','reagendado','anulada','anulado'].includes(status)) return 'external_cancelled';
  if(['atendido','en sala de espera'].includes(status)) return 'external_closed';
  return null;
}

export async function reconcilePendingAgainstSnapshots(pool=getPool()) {
  await ensure(pool);
  // Undo the short-lived incorrect reconciliation rule that treated Medinet confirmation as WhatsApp confirmation.
  // Do not resend: only reopen the existing request so the patient's WhatsApp reply can still be captured.
  await pool.query(`UPDATE attendance_direct.requests SET state='pending',verified_at=NULL,expires_at=GREATEST(expires_at,now()+interval '2 days')
    WHERE trial=false AND state='external_confirmed' AND coalesce(reply,'')='' AND intent IS NULL`);
  let rows;
  try {
    ({rows}=await pool.query(`WITH latest AS (
      SELECT DISTINCT ON (day) day,appointments FROM medinet_daily_snapshots ORDER BY day,synced_at DESC
    ), current AS (
      SELECT (a->>'id')::bigint appointment_id,a->'estado'->>'nombre' medinet_status
      FROM latest,lateral jsonb_array_elements(appointments) a
      WHERE (a->>'id') ~ '^[0-9]+$'
    )
    SELECT r.id,c.medinet_status
    FROM attendance_direct.requests r JOIN current c ON (r.snapshot->>'id')::bigint=c.appointment_id
    WHERE r.trial=false AND r.state='pending' AND (r.snapshot->>'id') ~ '^[0-9]+$'`));
  } catch(error) {
    if(error?.code==='42P01') return [];
    throw error;
  }
  const reconciled=[];
  for(const row of rows){
    const state=externalStateForMedinetStatus(row.medinet_status);if(!state)continue;
    const updated=await pool.query(`UPDATE attendance_direct.requests SET state=$2,medinet_status=$3,verified_at=now(),expires_at=now()
      WHERE id=$1 AND state='pending' RETURNING id,state,medinet_status`,[row.id,state,row.medinet_status]);
    if(updated.rows[0])reconciled.push(updated.rows[0]);
  }
  return reconciled;
}


export function multiAppointmentPrompt(items=[]) {
  const rows=[...items].sort((a,b)=>String(a.time).localeCompare(String(b.time))).map((a,i)=>`${i+1}. ${a.time} · ${a.type||'Consulta'} · ${a.professional}`);
  return `Veo que tienes ${rows.length} citas hoy:\n${rows.join('\n')}\n\n¿Confirmas ambas? Responde SÍ para confirmar todas. Si necesitas cancelar o reagendar una, responde NO o REAGENDAR y te preguntaré cuál.`;
}
async function sameDaySiblings(pool,r,now) {
  let rows;
  try { ({rows}=await pool.query(`SELECT appointments FROM medinet_daily_snapshots WHERE day=$1::date ORDER BY synced_at DESC LIMIT 1`,[r.snapshot.date])); }
  catch(error){ if(error?.code==='42P01') return []; throw error; }
  const raw=rows?.[0]?.appointments;if(!Array.isArray(raw))return [];
  const baseRun=norm(r.snapshot.patientRun||''),baseName=norm(r.snapshot.patient||'');
  const out=[];
  for(const item of raw){
    try{
      const a=normalizeAppointment(item);
      const samePatient=(baseRun&&norm(a.patientRun||'')===baseRun)||(!baseRun&&norm(a.patient||'')===baseName);
      if(a.id!==Number(r.snapshot.id)&&a.phone===r.phone&&a.date===r.snapshot.date&&samePatient&&eligible(a,now))out.push(a);
    }catch{}
  }
  return out.sort((a,b)=>a.time.localeCompare(b.time));
}

export async function sendPendingTwoHourFollowups({pool=getPool(),send=sendMeta,now=new Date()}={}) {
  const chileHour=Number(new Intl.DateTimeFormat('en-US',{timeZone:'America/Santiago',hour:'2-digit',hour12:false}).format(now));
  if(chileHour<7 || chileHour>=21)return {eligible:0,sent:0,duplicate:0,failed:0,quietHours:true};
  await reconcilePendingAgainstSnapshots(pool);
  return lock(pool,async db=>{
    const {rows}=await db.query(`SELECT * FROM attendance_direct.requests
      WHERE trial=false AND state='pending' AND coalesce(reply,'')=''
        AND created_at <= $1::timestamptz - interval '2 hours' AND expires_at>$1
      ORDER BY created_at,id LIMIT 100`,[now]);
    const summary={eligible:0,sent:0,duplicate:0,failed:0};
    for(const r of rows){
      if(!future(r.snapshot,now))continue;
      summary.eligible++;
      try{const mid=await sendOnce(db,`followup2h:${r.id}`,r.phone,template(r.snapshot,false),send);if(mid)summary.sent++;else summary.duplicate++;}
      catch(e){summary.failed++;console.error('[attendance-direct/followup-2h]',r.id,e.message);}
    }
    return summary;
  });
}

export async function processEvents({pool=getPool(),send=sendMeta,read=readAppointment,write=writeAppointment,now=new Date()}={}) {
  return lock(pool,async db=>{
    await reconcilePendingAgainstSnapshots(pool);
    // Crash after claim: no replay of uncertain external effects.
    const interrupted=await db.query("UPDATE attendance_direct.events SET state='needs_review' WHERE state='processing' RETURNING phone");
    for(const row of interrupted.rows)await pause(db,row.phone,'interrupted_processing');
    const {rows}=await db.query("SELECT * FROM attendance_direct.events WHERE state='pending' ORDER BY (payload->>'at')::numeric,created_at,id LIMIT 30");
    for(const row of rows){const e=row.payload;
      if(e.kind==='status') {
        // Delivery receipts never imply appointment confirmation; preserve stronger evidence.
        await db.query(`UPDATE attendance_direct.requests SET delivery=$2 WHERE message_id=$1 AND
          CASE $2 WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'sent' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END >
          CASE delivery WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'sent' THEN 2 WHEN 'failed' THEN 1 ELSE 0 END`,[e.messageId,e.status]);
        await db.query("UPDATE attendance_direct.events SET state='done' WHERE id=$1",[row.id]);continue;
      }
      if(process.env.ATTENDANCE_DIRECT_MODE!=='live' && e.phone!==TRIAL_PHONE){await db.query("UPDATE attendance_direct.events SET state='test_ignored' WHERE id=$1",[row.id]);continue;}
      if(!Number.isFinite(e.at)||now-e.at>600000||e.at-now>60000){await db.query("UPDATE attendance_direct.events SET state='stale' WHERE id=$1",[row.id]);continue;}
      await db.query("UPDATE attendance_direct.events SET state='processing' WHERE id=$1",[row.id]);
      let r;
      try {
        if((await db.query('SELECT paused FROM attendance_direct.control WHERE phone=$1',[e.phone])).rows[0]?.paused){await db.query("UPDATE attendance_direct.events SET state='human_paused' WHERE id=$1",[row.id]);continue;}
        const list=await db.query('SELECT * FROM attendance_direct.requests WHERE phone=$1 AND expires_at>$2',[e.phone,now]);
        r=selectRequest(list.rows,e,now);
        const {intent}=await classifyInbound(e.text);
        let action=r?decision(r.state,intent):'human';
        if(r?.state==='rescheduling') action='reschedule_continue';
        if(r?.state==='multi_choice') action=intent==='confirm'?'multi_confirm':intent==='cancel'?'multi_cancel':intent==='reschedule'?'multi_reschedule':'human';
        if(r && !r.trial && !future(r.snapshot,now))action='human';
        if(action==='duplicate'){await db.query("UPDATE attendance_direct.events SET state='duplicate_intent' WHERE id=$1",[row.id]);continue;}
        if(r)await db.query('UPDATE attendance_direct.requests SET reply=$2,intent=$3 WHERE id=$1',[r.id,e.text,intent]);
        let reply,replyBody;
        if(r && !r.trial && r.state==='pending' && ['confirm','cancel','reschedule'].includes(action)){
          const siblings=await sameDaySiblings(pool,r,now);
          if(siblings.length){
            const group=[r.snapshot,...siblings].sort((a,b)=>a.time.localeCompare(b.time));
            const grouped={...r.snapshot,multiAppointments:group};
            await db.query("UPDATE attendance_direct.requests SET state='multi_choice',snapshot=$2 WHERE id=$1",[r.id,JSON.stringify(grouped)]);
            reply=multiAppointmentPrompt(group);
            await sendOnce(db,`ack:${e.id}`,e.phone,{type:'text',text:{body:reply}},send);
            await db.query("UPDATE attendance_direct.events SET state='done' WHERE id=$1",[row.id]);
            continue;
          }
        }
        if(action==='multi_confirm' && r){
          const group=Array.isArray(r.snapshot.multiAppointments)?r.snapshot.multiAppointments:[];
          if(group.length<2)throw Error('multi_appointments_missing');
          const fresh=[];
          for(const a of group){const f=await read(a.id);if(f.fingerprint!==a.fingerprint||!eligible(f,now))throw Error('appointment_changed');fresh.push(f);}
          const receipts=[];
          for(const f of fresh){const receipt=f.status==='confirmado'?f:await write(f.id,'confirm');if(receipt.fingerprint!==f.fingerprint||receipt.status!=='confirmado')throw Error('medinet_unverified');receipts.push(receipt);}
          await db.query('UPDATE attendance_direct.requests SET state=$2,medinet_status=$3,verified_at=now(),expires_at=now() WHERE id=$1',[r.id,'confirm','confirmado']);
          for(let i=1;i<group.length;i++)await db.query(`INSERT INTO attendance_direct.requests(request_key,snapshot,phone,trial,state,delivery,reply,intent,medinet_status,verified_at,expires_at,actor)
            VALUES($1,$2,$3,false,'confirm',$4,$5,'confirm','confirmado',now(),now(),'multi-confirm') ON CONFLICT(request_key) DO NOTHING`,[`multi-${r.id}-${group[i].id}`,JSON.stringify(group[i]),r.phone,r.delivery||'accepted',e.text]);
          reply=`Listo. Quedaron confirmadas tus ${group.length} citas de hoy:
${group.map(a=>`• ${a.time} · ${a.type||'Consulta'} · ${a.professional}`).join('\n')}`;
        }else if((action==='multi_cancel'||action==='multi_reschedule') && r){
          const group=Array.isArray(r.snapshot.multiAppointments)?r.snapshot.multiAppointments:[];
          await db.query("UPDATE attendance_direct.requests SET state=$2 WHERE id=$1",[r.id,action==='multi_cancel'?'multi_cancel_choice':'multi_reschedule_choice']);
          reply=`¿Cuál cita quieres ${action==='multi_cancel'?'cancelar':'reagendar'}?
${group.map((a,i)=>`${i+1}. ${a.time} · ${a.type||'Consulta'} · ${a.professional}`).join('\n')}
Responde con el número.`;
        }else if((action==='reschedule'||action==='reschedule_continue') && r){
          const selection=String(e.selectionId||'');let inboundText=e.text;
          const slotPrefix=`rs:${r.snapshot.id}:`,datePrefix=`rsd:${r.snapshot.id}:`,timePrefix=`rst:${r.snapshot.id}:`;
          if(selection.startsWith(slotPrefix)){const selected=selection.slice(slotPrefix.length);inboundText=/^\d+$/.test(selected)?selected:selected==='none'?'Ninguna':e.text;}
          else if(selection.startsWith(datePrefix)){const selected=selection.slice(datePrefix.length);inboundText=selected;}
          else if(selection.startsWith(timePrefix)){const selected=selection.slice(timePrefix.length);inboundText=selected==='other'?'Otra fecha':/^\d{4}$/.test(selected)?`${selected.slice(0,2)}:${selected.slice(2)}`:e.text;}
          const flow=await rescheduleWithMelania({...r.snapshot,trial:r.trial===true},inboundText);
          const nextState=flow.status==='completed'?'rescheduled':flow.status==='needs_review'?'human':'rescheduling';
          await db.query('UPDATE attendance_direct.requests SET state=$2,medinet_status=$3 WHERE id=$1',[r.id,nextState,flow.status]);
          if(flow.status==='needs_review') await pause(db,e.phone,'reschedule_needs_review');
          reply=flow.reply||'Estoy revisando otras horas con el mismo profesional.';
          if(flow.status==='choosing'&&flow.choiceKind==='date'&&Array.isArray(flow.dates)&&flow.dates.length){
            replyBody=rescheduleDateList(r.snapshot.id,flow.dates,r.snapshot.professional,r.snapshot.branch);
          }else if(flow.status==='choosing'&&flow.choiceKind==='time'&&Array.isArray(flow.slots)&&flow.slots.length){
            replyBody=rescheduleTimeList(r.snapshot.id,flow.slots,r.snapshot.professional,r.snapshot.branch);
          }else if(flow.status==='choosing'&&Array.isArray(flow.slots)&&flow.slots.length){
            replyBody=rescheduleList(r.snapshot.id,flow.slots,r.snapshot.professional,r.snapshot.branch);
          }
        }else if(action==='human'){
          await pause(db,e.phone,action);
          if(r)await db.query("UPDATE attendance_direct.requests SET state='human' WHERE id=$1",[r.id]);
          reply=supportText;
        }else if(r.trial){
          await db.query('UPDATE attendance_direct.requests SET state=$2 WHERE id=$1',[r.id,action]);
          reply=`Prueba recibida: ${action==='confirm'?'confirmar':'cancelar'}. No se modificó ninguna cita real.`;
        }else {
          const fresh=await read(r.snapshot.id);
          if(fresh.fingerprint!==r.snapshot.fingerprint||!eligible(fresh,now))throw Error('appointment_changed');
          await db.query("UPDATE attendance_direct.requests SET state='uncertain' WHERE id=$1",[r.id]);
          const receipt=await write(r.snapshot.id,action);
          if(receipt.fingerprint!==r.snapshot.fingerprint||!(action==='confirm'?['confirmado']:['cancelada','cancelado']).includes(receipt.status))throw Error('medinet_unverified');
          await db.query('UPDATE attendance_direct.requests SET state=$2,medinet_status=$3,verified_at=now(),expires_at=now() WHERE id=$1',[r.id,action,receipt.status]);
          reply=action==='confirm'?`Tu cita quedó confirmada. ¡Te esperamos!${locationDetails(r.snapshot).text?`\n\n${locationDetails(r.snapshot).text}`:''}`:'Tu cita quedó cancelada.';
        }
        await sendOnce(db,`ack:${e.id}`,e.phone,replyBody||{type:'text',text:{body:reply}},send);
        await db.query("UPDATE attendance_direct.events SET state=$2 WHERE id=$1",[row.id,action==='human'?'needs_review':'done']);
      }catch(error){
        await pause(db,e.phone,'needs_review');
        if(r)await db.query("UPDATE attendance_direct.requests SET error='processing_needs_review' WHERE id=$1",[r.id]);
        await db.query("UPDATE attendance_direct.events SET state='needs_review' WHERE id=$1",[row.id]);
      }
    }
    return {processed:rows.length};
  });
}
