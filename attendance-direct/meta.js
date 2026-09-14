import { createHmac, timingSafeEqual } from 'node:crypto';
export const PHONE_ID = '1107398659118949';
export const TRIAL_PHONE = '56987297033';
export const SUPPORT = 'https://wa.me/56953386191?text=Necesito%20ayuda%20con%20mi%20cita';
export function validSignature(raw, signature, secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(signature || '')) return false;
  return timingSafeEqual(Buffer.from(signature.slice(7),'hex'),createHmac('sha256',secret).update(raw).digest());
}
export function parseWebhook(body) {
  if(body?.object !== 'whatsapp_business_account') return [];
  const events=[];
  for(const entry of body.entry || []) for(const change of entry.changes || []) {
    const v=change.value;
    if(change.field!=='messages'||v?.metadata?.phone_number_id!==PHONE_ID) continue;
    for(const m of v.messages || []) if(m.id && /^569\d{8}$/.test(m.from)) events.push({
      id:m.id,phone:m.from,kind:'message',at:Number(m.timestamp)*1000,
      text:String(m.text?.body||m.button?.text||m.interactive?.button_reply?.title||m.interactive?.list_reply?.title||'').slice(0,4000),replyTo:m.context?.id||null
    });
    for(const s of v.statuses || []) if(s.id && s.recipient_id) events.push({
      id:`status:${s.id}:${s.status}:${s.timestamp}`,messageId:s.id,phone:s.recipient_id,
      kind:'status',status:s.status,at:Number(s.timestamp)*1000
    });
  }
  return events;
}
export function metaConfig(env=process.env) {
  return {
    token: env.ATTENDANCE_META_TOKEN || env.META_WHATSAPP_SYSTEM_TOKEN || env.META_ACCESS_TOKEN,
    appSecret: env.ATTENDANCE_META_APP_SECRET || env.META_APP_SECRET,
    version: env.ATTENDANCE_META_VERSION || 'v25.0'
  };
}
export async function sendMeta(phone, body, {env=process.env, fetchImpl=fetch}={}) {
  const testOverride=env.ATTENDANCE_DIRECT_MODE!=='live' && phone===TRIAL_PHONE && env.ATTENDANCE_DIRECT_TEST_SEND_ENABLED==='true';
  if(env.ATTENDANCE_DIRECT_SEND_ENABLED!=='true' && !testOverride) throw Error('direct_send_disabled');
  if(env.ATTENDANCE_DIRECT_CUTOVER_VERIFIED!=='true' && !testOverride) throw Error('direct_cutover_not_verified');
  if(!/^569\d{8}$/.test(phone)) throw Error('invalid_phone');
  if(env.ATTENDANCE_DIRECT_MODE!=='live' && phone!==TRIAL_PHONE) throw Error('trial_recipient_only');
  const {token,version}=metaConfig(env);
  if(!token || !/^v\d+\.\d+$/.test(version||'')) throw Error('meta_config_missing');
  const r=await fetchImpl(`https://graph.facebook.com/${version}/${PHONE_ID}/messages`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({...body,messaging_product:'whatsapp',to:phone}),signal:AbortSignal.timeout(15000)
  });
  const data=await r.json();
  if(!r.ok || !data.messages?.[0]?.id) throw Error(`meta_send_unverified_${r.status}`);
  return data.messages[0].id;
}
export function template(a,trial) {
  const values=[trial?'Rodrigo (PRUEBA)':a.patient.split(' ')[0],trial?'PRUEBA, sin cita real':a.type||'consulta',a.professional,a.date.split('-').reverse().join('/'),a.time];
  return {type:'template',template:{name:'cly_confirm_appointment_v1',language:{code:'es_CL'},components:[{type:'body',parameters:values.map(text=>({type:'text',text}))}]}};
}
export const supportText = `Para ayudarte con tu cita, escribe al equipo aquí: ${SUPPORT}`;
