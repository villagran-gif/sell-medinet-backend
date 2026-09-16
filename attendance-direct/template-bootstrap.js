import { ensureConfirmTemplateV2, CONFIRM_TEMPLATE_V2, ensureCreatedTemplateV1, CREATED_TEMPLATE_V1 } from './template-admin.js';
import { processCreatedAppointments } from './created.js';

const summarize=(name,created,template)=>{
  const components=(template?.components||[]).map(c=>c.type==='BUTTONS'?{type:c.type,buttons:(c.buttons||[]).map(b=>({type:b.type,text:b.text}))}:{type:c.type});
  return {name,created,status:template?.status||null,category:template?.category||null,language:template?.language||null,components};
};

if(process.env.ATTENDANCE_META_ENSURE_CONFIRM_V2==='true'){
  ensureConfirmTemplateV2()
    .then(({created,template})=>console.log('[attendance-direct/meta-template-v2]',JSON.stringify(summarize(CONFIRM_TEMPLATE_V2,created,template))))
    .catch(e=>console.error('[attendance-direct/meta-template-v2]',e.message));
}

if(process.env.ATTENDANCE_META_ENSURE_CREATED_V1==='true'){
  ensureCreatedTemplateV1()
    .then(({created,template})=>console.log('[attendance-direct/meta-created-v1]',JSON.stringify(summarize(CREATED_TEMPLATE_V1,created,template))))
    .catch(e=>console.error('[attendance-direct/meta-created-v1]',e.message));
}

if(process.env.APPOINTMENT_CREATED_WHATSAPP_ENABLED==='true'){
  let busy=false;
  const run=async()=>{
    if(busy)return;busy=true;
    try{
      const r=await processCreatedAppointments();
      if(r.processed||r.review)console.log('[attendance-direct/appointment-created]',JSON.stringify(r));
    }catch(e){console.error('[attendance-direct/appointment-created]',e.message);}
    finally{busy=false;}
  };
  setTimeout(run,10000).unref();
  setInterval(run,5000).unref();
}
