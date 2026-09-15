import { parseEvent } from '../attendance/policy.js';
import { ingest, processEvents } from './engine.js';
import { getPool } from '../chatwoot-webhook/db.js';
import { TRIAL_PHONE } from './meta.js';
import { postPrivateNote, addConversationLabels } from '../chatwoot-webhook/lib/chatwoot-api.js';

const ok = reason => ({forwarded:true, attendanceDirect:true, reason});

function confirmationContext(a={}) {
  const first=String(a.patient||'Paciente').trim().split(/\s+/)[0]||'Paciente';
  const date=String(a.date||'').split('-').reverse().join('/');
  return `📅 CONFIRMACIÓN AUTOMÁTICA · MELANIA\nMensaje enviado al paciente:\nHola ${first}, soy MelanIA de Clínyco 👋. Te confirmamos tu cita de ${a.type||'consulta'} con ${a.professional||'su profesional'} el ${date} a las ${a.time||''}. ¿CONFIRMAS? Responde SÍ para confirmar, NO para cancelar, o REAGENDAR si quieres cambiarla.`;
}

async function annotateRequest(pool,row,conversationId) {
  if(!row||!conversationId)return false;
  await pool.query('UPDATE attendance_direct.requests SET chatwoot_conversation_id=COALESCE(chatwoot_conversation_id,$2) WHERE id=$1',[row.id,conversationId]);
  const current=(await pool.query('SELECT chatwoot_context_noted_at FROM attendance_direct.requests WHERE id=$1',[row.id])).rows[0];
  if(current?.chatwoot_context_noted_at)return false;
  try{await addConversationLabels(conversationId,['confirmacion']);}catch(e){console.warn('[attendance-direct/chatwoot-label]',e.message);}
  try{await postPrivateNote(conversationId,confirmationContext(row.snapshot||{}));await pool.query('UPDATE attendance_direct.requests SET chatwoot_context_noted_at=now() WHERE id=$1',[row.id]);return true;}
  catch(e){console.warn('[attendance-direct/chatwoot-context]',e.message);return false;}
}

async function annotateChatwoot(m) {
  const pool=getPool();
  const {rows}=await pool.query(`SELECT id,snapshot,chatwoot_context_noted_at FROM attendance_direct.requests WHERE phone=$1 AND expires_at>now() AND state IN ('pending','multi_choice','rescheduling') ORDER BY created_at DESC LIMIT 2`,[m.phone]);
  if(rows.length!==1)return;
  await annotateRequest(pool,rows[0],m.conversationId);
}

export async function backfillChatwootContexts({pool=getPool(),date}={}) {
  const day=String(date||new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('date_required');
  const {rows}=await pool.query(`SELECT r.id,r.snapshot,r.chatwoot_context_noted_at,
    (SELECT NULLIF(e.payload->'conversation'->>'id','')::bigint FROM chatwoot.raw_events e
      WHERE e.event_type='message_created'
        AND regexp_replace(coalesce(e.payload->'sender'->>'phone_number',''),'\D','','g')=r.phone
        AND e.received_at>=r.created_at
      ORDER BY e.received_at ASC LIMIT 1) conversation_id
    FROM attendance_direct.requests r
    WHERE r.trial=false AND r.snapshot->>'date'=$1 AND r.chatwoot_context_noted_at IS NULL`,[day]);
  let annotated=0;
  for(const row of rows)if(row.conversation_id&&await annotateRequest(pool,row,row.conversation_id))annotated++;
  return {date:day,candidates:rows.length,annotated};
}

export async function handleInboundEvent(ev) {
  const m = parseEvent(ev.payload);
  if (!m) return ok('not_message');
  if (!m.incoming) return ok('non_incoming');
  // Test-only recovery: earlier failed trials may have paused the fixed test phone.
  // Never auto-resume real patients.
  if (process.env.ATTENDANCE_DIRECT_MODE !== 'live' && m.phone === TRIAL_PHONE) {
    await getPool().query(`UPDATE attendance_direct.control SET paused=false,reason='test_resume',updated_at=now() WHERE phone=$1`, [m.phone]);
  }
  await annotateChatwoot(m);
  const event = {
    id: `cw:${m.id}`,
    conversationId: m.conversationId,
    phone: m.phone,
    kind: 'message',
    at: m.createdAt.valueOf(),
    text: m.text,
    replyTo: null
  };
  await ingest([event]);
  await processEvents();
  return ok('processed');
}
