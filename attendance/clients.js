import { ACCOUNT, INBOX, PHONE, digits, snapshot } from './policy.js';
const timeout = () => AbortSignal.timeout(15000);
export async function cw(path, body) {
  if(!process.env.CHATWOOT_API_TOKEN) throw new Error('chatwoot_credentials_missing');
  const r=await fetch(`https://app.chatwoot.com/api/v1/accounts/${ACCOUNT}${path}`,{
    method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',api_access_token:process.env.CHATWOOT_API_TOKEN},
    body:body===undefined?undefined:JSON.stringify(body),signal:timeout()});
  if(!r.ok)throw new Error(`chatwoot_http_${r.status}`); return r.json();
}
export async function verifyConversation(id, phone) {
  const [i,c]=await Promise.all([cw(`/inboxes/${INBOX}`),cw(`/conversations/${id}`)]);
  if(Number(i.id)!==INBOX||i.channel_type!=='Channel::Whatsapp'||digits(i.phone_number)!==PHONE
    ||Number(c.inbox_id)!==INBOX||Number(c.id)!==Number(id)||digits(c.meta?.sender?.phone_number)!==phone)
    throw new Error('channel_or_recipient_mismatch');
  return c;
}
export async function conversationFor(phone) {
  const result=await cw(`/contacts/search?q=${encodeURIComponent('+'+phone)}`);
  const contacts=(result.payload||[]).filter(c=>digits(c.phone_number)===phone);
  if(contacts.length!==1) throw new Error('contact_missing_or_ambiguous');
  const result2=await cw(`/contacts/${contacts[0].id}/conversations`);
  const conversations=(result2.payload||[]).filter(c=>Number(c.inbox_id)===INBOX);
  if(conversations.length>1)throw new Error('conversation_ambiguous');
  if(conversations.length===1)return conversations[0].id;
  const created=await cw('/conversations',{source_id:phone,inbox_id:INBOX,contact_id:contacts[0].id,status:'pending'});
  if(!created?.id)throw new Error('conversation_not_created'); return created.id;
}
export async function send(id,content,templateParams) {
  const r=await cw(`/conversations/${id}/messages`,{content,message_type:'outgoing',private:false,
    content_attributes:{attendance_automation:true},...(templateParams?{template_params:templateParams}:{})});
  if(!r?.id||r.status==='failed')throw new Error('message_not_accepted'); return r;
}
export async function handoff(id,reason) {
  // Private notes preserve context for the existing assignee; no reassignment.
  await cw(`/conversations/${id}/messages`,{content:`Confirmaciones: requiere atención del equipo. Motivo: ${reason}.`,message_type:'outgoing',private:true});
  await cw(`/conversations/${id}/toggle_status`,{status:'open'});
}
let jwt; let expires=0;
async function auth() {
  if(jwt&&expires>Date.now())return `MEDINET_JWT ${jwt}`;
  const username=process.env.MEDINET_USER||process.env.MEDINET_JWT_USERNAME;
  const password=process.env.MEDINET_USER_KEY||process.env.MEDINET_JWT_PASSWORD;
  if(username&&password){
    const r=await fetch('https://clinyco.medinetapp.com/token-login/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password}),signal:timeout()});
    if(!r.ok)throw new Error('medinet_auth_failed');const j=await r.json();if(!j.token)throw new Error('medinet_token_missing');
    jwt=j.token;expires=Date.now()+3600000;return `MEDINET_JWT ${jwt}`;
  }
  if(process.env.MEDINET_API_TOKEN)return `Token ${process.env.MEDINET_API_TOKEN}`;
  throw new Error('medinet_credentials_missing');
}
async function medinet(path, body) {
  const r=await fetch(`https://clinyco.medinetapp.com/api-public/schedule/appointment/${path}`,{
    method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:await auth()},body:body===undefined?undefined:JSON.stringify(body),signal:timeout()});
  if(!r.ok)throw new Error(`medinet_http_${r.status}`);return r.json();
}
export const readAppointment = async id => snapshot(await medinet(`${id}/`));
export async function writeAppointment(id,intent) {
  if(process.env.ATTENDANCE_MEDINET_WRITE_ENABLED!=='true')throw new Error('medinet_write_disabled');
  if(!['confirm','cancel'].includes(intent))throw new Error('unsupported_action');
  await medinet(`update-appointment-state/${id}/`,{action:intent==='confirm'?'Confirm':'Cancel',observation:'Respuesta de asistencia recibida por WhatsApp Clinyco.'});
  return readAppointment(id);
}

export async function ensureLabel() {
  const data=await cw('/labels');const labels=Array.isArray(data)?data:data.payload;
  if(!Array.isArray(labels))throw new Error('labels_unavailable');
  if(!labels.some(x=>x.title==='confirmacion_automatica'))await cw('/labels',{title:'confirmacion_automatica',description:'Confirmaciones de citas por WhatsApp',color:'#168878',show_on_sidebar:true});
}

export async function rescheduleWithMelania(a,text) {
  const base=String(process.env.CLINYCO_AI_BASE_URL||'').replace(/\/+$/,'');
  const token=process.env.CLINYCO_AI_HANDOFF_TOKEN;
  if(!base||!token)throw new Error('melania_reschedule_config_missing');
  const r=await fetch(`${base}/melania/reschedule-direct`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
    body:JSON.stringify({external_id:a.id,branch_id:a.branchId,patient:{phone:a.phone,name:a.patient,run:a.patientRun,email:a.patientEmail},professional:{id:a.professionalId,name:a.professional},appointment_at:`${a.date}T${a.time}:00-03:00`,inbound_message:String(text||'') }),signal:AbortSignal.timeout(30000)});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(`melania_reschedule_${r.status}_${data.error||'failed'}`);return data;
}
