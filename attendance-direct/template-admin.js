import { metaConfig } from './meta.js';

export const WABA_ID = '1485224193347148';
export const CONFIRM_TEMPLATE_V2 = 'cly_confirm_appointment_v2';
export const CREATED_TEMPLATE_V1 = 'cly_appointment_created_v1';
export const RECOVERY_TEMPLATE_V1 = 'cly_pending_followup_v1';

function graphBase(env=process.env){
  const {version}=metaConfig(env);
  return `https://graph.facebook.com/${version}`;
}

export async function getTemplateByName(name,{env=process.env,fetchImpl=fetch}={}){
  const {token}=metaConfig(env); if(!token) throw Error('meta_config_missing');
  const u=`${graphBase(env)}/${WABA_ID}/message_templates?name=${encodeURIComponent(name)}&fields=name,status,category,language,components`;
  const r=await fetchImpl(u,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)});
  const data=await r.json(); if(!r.ok) throw Error(`meta_template_lookup_${r.status}`);
  return data.data||[];
}

export function confirmTemplateV2Definition(){
  return {
    name: CONFIRM_TEMPLATE_V2,
    language:'es_CL',
    category:'UTILITY',
    components:[
      {type:'BODY',text:'Hola {{1}}, soy MelanIA de Clínyco 👋. Te confirmamos tu cita de {{2}} con {{3}} el {{4}} a las {{5}}. ¿CONFIRMAS?',example:{body_text:[['Rodrigo','Evaluación Cirugía','Rodrigo Villagran Morales','17/09/2026','17:30']]}},
      {type:'BUTTONS',buttons:[
        {type:'QUICK_REPLY',text:'SÍ'},
        {type:'QUICK_REPLY',text:'NO'},
        {type:'QUICK_REPLY',text:'REAGENDAR'}
      ]}
    ]
  };
}

export function createdTemplateV1Definition(){
  return {
    name: CREATED_TEMPLATE_V1,
    language:'es_CL',
    category:'UTILITY',
    components:[
      {type:'BODY',text:'Hola {{1}} 👋. Tu cita fue agendada correctamente.\n\nTipo: {{2}}\nProfesional: {{3}}\nFecha: {{4}} a las {{5}}\nSede / modalidad: {{6}}\n\nMás adelante te pediremos confirmar tu asistencia.',example:{body_text:[['Rodrigo','Control Post-Operatorio de Cirugía','Rodrigo Villagran Morales','17/09/2026','11:40','Antofagasta Mall Arauco Express']]}}
    ]
  };
}

export function recoveryTemplateV1Definition(){
  return {
    name: RECOVERY_TEMPLATE_V1,
    language:'es_CL',
    category:'UTILITY',
    components:[
      {type:'BODY',text:'Hola {{1}}, quedó pendiente {{2}}. Disculpa la demora. Si aún necesitas ayuda, continúa con nuestro equipo aquí.',example:{body_text:[['Luisa','tu solicitud de reagendar una cita']]}},
      {type:'BUTTONS',buttons:[
        {type:'URL',text:'CONTINUAR',url:'https://wa.me/56953386191?text=Necesito%20retomar%20una%20solicitud%20pendiente'}
      ]}
    ]
  };
}

async function ensureTemplate(name,definition,{env=process.env,fetchImpl=fetch}={}){
  const existing=await getTemplateByName(name,{env,fetchImpl});
  if(existing.length)return {created:false,template:existing[0]};
  const {token}=metaConfig(env); if(!token) throw Error('meta_config_missing');
  const r=await fetchImpl(`${graphBase(env)}/${WABA_ID}/message_templates`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(definition),signal:AbortSignal.timeout(15000)
  });
  const data=await r.json(); if(!r.ok) throw Error(`meta_template_create_${r.status}:${data?.error?.message||'failed'}`);
  const after=await getTemplateByName(name,{env,fetchImpl});
  return {created:true,template:after[0]||data};
}

export function ensureConfirmTemplateV2(options={}){
  return ensureTemplate(CONFIRM_TEMPLATE_V2,confirmTemplateV2Definition(),options);
}

export function ensureCreatedTemplateV1(options={}){
  return ensureTemplate(CREATED_TEMPLATE_V1,createdTemplateV1Definition(),options);
}

export function ensureRecoveryTemplateV1(options={}){
  return ensureTemplate(RECOVERY_TEMPLATE_V1,recoveryTemplateV1Definition(),options);
}
