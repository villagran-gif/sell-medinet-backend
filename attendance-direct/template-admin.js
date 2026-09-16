import { metaConfig } from './meta.js';

export const WABA_ID = '1485224193347148';
export const CONFIRM_TEMPLATE_V2 = 'cly_confirm_appointment_v2';

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

export async function ensureConfirmTemplateV2({env=process.env,fetchImpl=fetch}={}){
  const existing=await getTemplateByName(CONFIRM_TEMPLATE_V2,{env,fetchImpl});
  if(existing.length) return {created:false,template:existing[0]};
  const {token}=metaConfig(env); if(!token) throw Error('meta_config_missing');
  const r=await fetchImpl(`${graphBase(env)}/${WABA_ID}/message_templates`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify(confirmTemplateV2Definition()),signal:AbortSignal.timeout(15000)
  });
  const data=await r.json(); if(!r.ok) throw Error(`meta_template_create_${r.status}:${data?.error?.message||'failed'}`);
  const after=await getTemplateByName(CONFIRM_TEMPLATE_V2,{env,fetchImpl});
  return {created:true,template:after[0]||data};
}
