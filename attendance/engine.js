import { readFile } from 'node:fs/promises';
import { getPool } from '../chatwoot-webhook/db.js';
import { classifyInbound } from '../confirmations/classifier.js';
import * as api from './clients.js';
import { INBOX, parseEvent, selectRequest, decision, acknowledgment, eligible } from './policy.js';
const initialized=new WeakMap();
export async function ensure(pool=getPool()) {
  if(!initialized.has(pool))initialized.set(pool,readFile(new URL('./schema.sql',import.meta.url),'utf8').then(sql=>pool.query(sql)).catch(e=>{initialized.delete(pool);throw e;}));
  return initialized.get(pool);
}
export async function locked(pool,key,work) {
  await ensure(pool);const db=await pool.connect();
  try{await db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`attendance:${key}`]);return await work(db);}
  finally{try{await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`attendance:${key}`]);}finally{db.release();}}
}
const futureSnapshot=(a,now)=>eligible({...a,status:'agendado'},now);
const result=reason=>({forwarded:true,attendance:true,reason});
async function pause(db,id,reason){await db.query(`INSERT INTO attendance.control(conversation_id,paused,reason) VALUES($1,true,$2)
  ON CONFLICT(conversation_id) DO UPDATE SET paused=true,reason=$2,updated_at=now()`,[id,reason]);}
export async function handleInboundEvent(ev,{pool=getPool(),client=api,now=new Date()}={}) {
  const m=parseEvent(ev.payload);if(!m)return result('not_attendance_message');
  // Activation is forward-only. Never replay old patient instructions into a live appointment.
  if(!Number.isFinite(m.createdAt.valueOf())||now-m.createdAt>10*60*1000||m.createdAt-now>60000)return result('stale_event');
  return locked(pool,m.conversationId,async db=>{
    if(m.human){
      const own=await db.query('SELECT 1 FROM attendance.events WHERE ack_id=$1 UNION ALL SELECT 1 FROM attendance.requests WHERE message_id=$1',[m.id]);
      if(!own.rows.length)await pause(db,m.conversationId,'human_message');
      return result('human_pause');
    }
    if(!m.incoming)return result('non_incoming');
    const claim=await db.query('INSERT INTO attendance.events(message_id,conversation_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING message_id',[m.id,m.conversationId]);
    if(!claim.rows.length)return result('duplicate');
    const finish=async state=>{await db.query('UPDATE attendance.events SET state=$2 WHERE message_id=$1',[m.id,state]);return result(state);};
    try{
      const control=await db.query('SELECT paused FROM attendance.control WHERE conversation_id=$1',[m.conversationId]);
      const conv=await client.verifyConversation(m.conversationId,m.phone);
      if(control.rows[0]?.paused||conv.custom_attributes?.attendance_paused===true||conv.status==='snoozed')return finish('human_paused');
      const all=await db.query(`SELECT * FROM attendance.requests WHERE conversation_id=$1 AND state<>'sending' AND expires_at>$2 ORDER BY sent_at DESC`,[m.conversationId,now]);
      const request=selectRequest(all.rows,m,now);
      if(request && !request.trial && !futureSnapshot(request.snapshot,now))throw new Error('appointment_expired');
      if(!request){await pause(db,m.conversationId,'no_unique_current_request');await client.handoff(m.conversationId,'No hay una única cita vigente asociada a esta respuesta.');return finish('human');}
      const {intent}=await classifyInbound(m.text);
      const action=decision(request.state,intent);
      await db.query('UPDATE attendance.events SET request_id=$2,intent=$3 WHERE message_id=$1',[m.id,request.id,intent]);
      if(action==='duplicate')return finish('duplicate_intent');
      let verified=false;
      if(action==='human'||action==='reschedule'){
        await pause(db,m.conversationId,action);
        await db.query('UPDATE attendance.requests SET state=$2,last_intent=$3 WHERE id=$1',[request.id,'human',intent]);
        await client.handoff(m.conversationId,action==='reschedule'?'Solicita reagendar; conservar la cita original.':'Pregunta o cambio de intención; verificar con el paciente.');
      }else if(!request.trial){
        const fresh=await client.readAppointment(request.appointment_id);
        if(fresh.fingerprint!==request.fingerprint||!eligible(fresh,now))throw new Error('appointment_changed_or_unavailable');
        // Persist uncertainty BEFORE making a remote mutation. A timeout is never retried blindly.
        await db.query("UPDATE attendance.requests SET state='uncertain',last_intent=$2 WHERE id=$1",[request.id,intent]);
        const receipt=await client.writeAppointment(request.appointment_id,action);
        const expected=action==='confirm'?['confirmado']:['cancelada','cancelado'];
        if(receipt.fingerprint!==request.fingerprint||!expected.includes(receipt.status))throw new Error('medinet_readback_mismatch');
        verified=true;
        await db.query('UPDATE attendance.requests SET state=$2,verified_at=now(),medinet_receipt=$3 WHERE id=$1',[request.id,action,JSON.stringify({id:receipt.id,status:receipt.status,fingerprint:receipt.fingerprint})]);
      }else await db.query('UPDATE attendance.requests SET state=$2,last_intent=$3 WHERE id=$1',[request.id,action,intent]);
      const ack=await client.send(m.conversationId,acknowledgment(action,verified,request.trial));
      await db.query('UPDATE attendance.events SET ack_id=$2,state=$3 WHERE message_id=$1',[m.id,ack.id,'completed']);
      // Resolved confirmations disappear from the active queue. Exceptions stay open for humans.
      if(['confirm','cancel'].includes(action))await client.cw(`/conversations/${m.conversationId}/toggle_status`,{status:'resolved'});
      return result('completed');
    }catch(error){
      await pause(db,m.conversationId,'processing_needs_review');
      await finish('needs_review');
      await client.handoff(m.conversationId,'No se pudo verificar la gestión automática. Revisar la agenda antes de actuar.').catch(()=>{});
      throw new Error(`attendance_needs_review:${error.message}`);
    }
  });
}
export async function sendRequest(a,{trial=false,pool=getPool(),client=api,conversationId,now=new Date()}={}) {
  if(process.env.ATTENDANCE_LIVE_SEND_ENABLED!=='true')throw new Error('attendance_sending_disabled');
  if(!trial&&process.env.ATTENDANCE_MODE!=='live')throw new Error('attendance_test_mode');
  if(trial&&a.phone!=='56987297033')throw new Error('trial_recipient_not_allowed');
  await client.ensureLabel();
  const id=conversationId||await client.conversationFor(a.phone);
  return locked(pool,id,async db=>{
    const conv=await client.verifyConversation(id,a.phone);
    const control=await db.query('SELECT paused FROM attendance.control WHERE conversation_id=$1',[id]);
    if(control.rows[0]?.paused||conv.custom_attributes?.attendance_paused===true||conv.status==='snoozed')throw new Error('human_paused');
    if(trial){
      const previous=await db.query('SELECT id FROM attendance.requests WHERE trial=true AND fingerprint=$1',[a.fingerprint]);
      if(previous.rows.length)return {skipped:'already_reserved'};
      await db.query('UPDATE attendance.requests SET expires_at=now() WHERE conversation_id=$1 AND trial=true',[id]);
    }
    if(!trial){const fresh=await client.readAppointment(a.id);if(!eligible(fresh,now)||fresh.fingerprint!==a.fingerprint)throw new Error('appointment_changed_or_ineligible');}
    // Reserve before sending, under a conversation lock. A crash/timeout leaves 'sending' for review.
    const claim=await db.query(`INSERT INTO attendance.requests(appointment_id,fingerprint,snapshot,phone,conversation_id,trial,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(appointment_id,fingerprint) DO NOTHING RETURNING *`,
      [trial?null:a.id,a.fingerprint,JSON.stringify(a),a.phone,id,trial,new Date(now.valueOf()+48*3600000)]);
    if(!claim.rows.length)return {skipped:'already_reserved'};
    const request=claim.rows[0];
    try{
      const variables={'1':trial?'Rodrigo (PRUEBA)':a.patient.split(' ')[0],'2':trial?'PRUEBA TECNICA, sin cita real':a.type||'Consulta','3':a.professional,'4':a.date.split('-').reverse().join('/'),'5':a.time};
      const message=await client.send(id,`Hola ${variables['1']}, ¿confirmas tu cita de ${variables['2']} con ${variables['3']} el ${variables['4']} a las ${variables['5']}?`,
        {name:'cly_confirm_appointment_v1',category:'UTILITY',language:'es_CL',processed_params:{body:variables}});
      await db.query("UPDATE attendance.requests SET message_id=$2,state='pending',sent_at=now() WHERE id=$1",[request.id,message.id]);
      // Preserve existing labels. Explicitly label only the dedicated workflow.
      const labels=await client.cw(`/conversations/${id}/labels`);
      await client.cw(`/conversations/${id}/labels`,{labels:[...new Set([...(labels.payload||[]),'confirmacion_automatica'])]});
      await client.cw(`/conversations/${id}/toggle_status`,{status:'pending'});
      return {requestId:request.id,conversationId:id,messageId:message.id,status:message.status||'accepted'};
    }catch(error){await pause(db,id,'outbound_needs_review');throw error;}
  });
}
export async function tick({pool=getPool(),client=api}={}) {
  await ensure(pool);
  if(process.env.ATTENDANCE_LIVE_SEND_ENABLED!=='true')return {disabled:true};
  const {rows}=await pool.query(`WITH next AS (SELECT id FROM attendance.jobs WHERE state='pending' AND send_at<=now() ORDER BY send_at,id LIMIT 10 FOR UPDATE SKIP LOCKED)
    UPDATE attendance.jobs j SET state='processing' FROM next WHERE j.id=next.id RETURNING j.*`);
  const summary={sent:0,review:0};
  for(const job of rows){try{
    const a=await client.readAppointment(job.appointment_id);
    if(a.professionalId!==Number(job.professional_id)||a.fingerprint!==job.fingerprint||!eligible(a))throw new Error('appointment_changed_or_ineligible');
    const sent=await sendRequest(a,{pool,client});
    await pool.query('UPDATE attendance.jobs SET state=$2 WHERE id=$1',[job.id,sent.skipped?'duplicate':'sent']);summary.sent++;
  }catch(e){await pool.query("UPDATE attendance.jobs SET state='needs_review',error=$2 WHERE id=$1",[job.id,String(e.message).slice(0,150)]);summary.review++;}}
  return summary;
}

export async function startupTrial() {
  const key=process.env.ATTENDANCE_TRIAL_ID;
  if(!key)return;
  if(!/^trial-[a-zA-Z0-9-]{8,80}$/.test(key))throw new Error('invalid_trial_id');
  return sendRequest({phone:'56987297033',patient:'Rodrigo',professional:'Profesional de prueba',date:new Date(Date.now()+86400000).toISOString().slice(0,10),time:'17:30',fingerprint:key},{trial:true,conversationId:399});
}
