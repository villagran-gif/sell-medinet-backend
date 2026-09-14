import { createHash } from 'node:crypto';
export const ACCOUNT = 162472;
export const INBOX = 107690;
export const PHONE = '56962718765';
export const digits = x => String(x || '').replace(/\D/g, '');
export const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const fullName = p => [p?.nombres, p?.paterno, p?.materno].filter(Boolean).join(' ');
export function snapshot(raw) {
  const a = raw?.data || raw;
  const result = { id: Number(a?.id), patientId: Number(a?.paciente?.id),
    patient: fullName(a?.paciente), phone: digits(a?.paciente?.telefono || a?.paciente?.telefono_2),
    professionalId: Number(a?.profesional?.id), professional: fullName(a?.profesional),
    branchId: Number(a?.sucursal?.id), branch: a?.sucursal?.nombre,
    date: String(a?.fecha || '').slice(0,10).replaceAll('/', '-'), time: String(a?.hora || '').slice(0,5),
    type: typeof a?.tipo === 'string' ? a.tipo : '', status: norm(a?.estado?.nombre) };
  if (![result.id,result.patientId,result.professionalId,result.branchId].every(x=>Number.isSafeInteger(x)&&x>0)
    || !/^569\d{8}$/.test(result.phone) || !/^\d{4}-\d{2}-\d{2}$/.test(result.date)
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(result.time) || !result.patient || !result.professional)
    throw new Error('appointment_identity_incomplete');
  result.fingerprint = createHash('sha256').update(JSON.stringify([result.id,result.patientId,result.phone,result.professionalId,result.branchId,result.date,result.time,result.type])).digest('hex');
  return result;
}
export function future(a, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return `${a.date} ${a.time}` > `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
export function eligible(a, now = new Date()) {
  return future(a,now) && ['agendado','confirmado'].includes(a.status)
    && !/prueba|test|agendar no|consulta scl|telemedicina solo|bloqueo/.test(norm(a.patient));
}
export function parseEvent(p) {
  if (p?.event !== 'message_created' || Number(p.account?.id)!==ACCOUNT || Number(p.conversation?.inbox_id)!==INBOX
      || !Number.isSafeInteger(Number(p.id)) || !Number.isSafeInteger(Number(p.conversation?.id))) return null;
  return {id:String(p.id),conversationId:String(p.conversation.id),phone:digits(p.sender?.phone_number),
    incoming:['incoming',0].includes(p.message_type)&&p.private!==true,
    human:['outgoing',1].includes(p.message_type)&&p.private!==true&&['user','User'].includes(p.sender?.type),
    text:String(p.content||'').trim(),replyTo:p.content_attributes?.in_reply_to ? String(p.content_attributes.in_reply_to):null,
    createdAt: typeof p.created_at==='number' ? new Date(p.created_at*1000) : new Date(p.created_at) };
}
export function selectRequest(rows, msg, now = new Date()) {
  // Include previously answered requests: do not accidentally attach a second reply to another appointment.
  const valid = rows.filter(r=>r.phone===msg.phone && String(r.conversation_id)===msg.conversationId
    && new Date(r.sent_at)<=msg.createdAt && new Date(r.expires_at)>now);
  const matches = msg.replyTo ? valid.filter(r=>String(r.message_id)===msg.replyTo) : valid;
  return matches.length===1 ? matches[0] : null;
}
export function decision(state, intent) {
  if (state==='human' || state==='uncertain') return 'human';
  if (state!=='pending') return state===intent ? 'duplicate' : 'human';
  return ['confirm','cancel','reschedule'].includes(intent) ? intent : 'human';
}
export function acknowledgment(intent, verified, trial=false) {
  if(trial) return `Prueba recibida: ${ {confirm:'confirmar',cancel:'cancelar',reschedule:'reagendar',human:'revisar con el equipo'}[intent] || 'revisar con el equipo' }. No se modificó ninguna cita real.`;
  if(intent==='confirm'&&verified) return 'Tu cita quedó confirmada. ¡Te esperamos!';
  if(intent==='cancel'&&verified) return 'Tu cita quedó cancelada.';
  if(intent==='reschedule') return 'Recibimos tu solicitud de cambio. El equipo te ayudará a buscar otra hora.';
  return 'El equipo revisará tu solicitud y te responderá por aquí.';
}
