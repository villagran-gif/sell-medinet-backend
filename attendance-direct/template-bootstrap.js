import { ensureConfirmTemplateV2, CONFIRM_TEMPLATE_V2 } from './template-admin.js';

if(process.env.ATTENDANCE_META_ENSURE_CONFIRM_V2==='true'){
  ensureConfirmTemplateV2()
    .then(({created,template})=>{
      const components=(template?.components||[]).map(c=>c.type==='BUTTONS'?{type:c.type,buttons:(c.buttons||[]).map(b=>({type:b.type,text:b.text}))}:{type:c.type});
      console.log('[attendance-direct/meta-template-v2]',JSON.stringify({name:CONFIRM_TEMPLATE_V2,created,status:template?.status||null,category:template?.category||null,language:template?.language||null,components}));
    })
    .catch(e=>console.error('[attendance-direct/meta-template-v2]',e.message));
}
