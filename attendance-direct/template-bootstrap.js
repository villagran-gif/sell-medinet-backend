import './internal-scheduler.js';
import { ensureConfirmTemplateV2, CONFIRM_TEMPLATE_V2, ensureCreatedTemplateV1, CREATED_TEMPLATE_V1, ensureRecoveryTemplateV1, RECOVERY_TEMPLATE_V1, getTemplateByName } from './template-admin.js';
import { processCreatedAppointments } from './created.js';
import { getPool } from '../chatwoot-webhook/db.js';
import { ensure as ensureDirect } from './engine.js';
import { sendMeta } from './meta.js';

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

if(process.env.ATTENDANCE_META_ENSURE_RECOVERY_V1==='true'){
  ensureRecoveryTemplateV1()
    .then(({created,template})=>console.log('[attendance-direct/meta-recovery-v1]',JSON.stringify(summarize(RECOVERY_TEMPLATE_V1,created,template))))
    .catch(e=>console.error('[attendance-direct/meta-recovery-v1]',e.message));
}


if(process.env.ATTENDANCE_RECOVERY_BATCH_JSON){
  let recoveryBusy=false,recoveryFinished=false;
  const runRecovery=async()=>{
    if(recoveryBusy||recoveryFinished)return;
    recoveryBusy=true;
    try{
      const templates=await getTemplateByName(RECOVERY_TEMPLATE_V1);
      if(templates?.[0]?.status!=='APPROVED')return;
      const items=JSON.parse(process.env.ATTENDANCE_RECOVERY_BATCH_JSON);
      if(!Array.isArray(items)||items.length>20)throw Error('recovery_batch_invalid');
      await ensureDirect();
      const db=getPool();
      let sent=0,duplicate=0,review=0;
      for(const item of items){
        const key=String(item?.key||'').trim();
        const phone=String(item?.phone||'').replace(/\D/g,'');
        const firstName=String(item?.firstName||'').trim();
        const subject=String(item?.subject||'').trim();
        if(!/^[a-zA-Z0-9_-]{8,80}$/.test(key)||!/^569\d{8}$/.test(phone)||!firstName||!subject){review++;continue;}
        const body={type:'template',template:{name:RECOVERY_TEMPLATE_V1,language:{code:'es_CL'},components:[{type:'body',parameters:[{type:'text',text:firstName.slice(0,80)},{type:'text',text:subject.slice(0,180)}]}]}};
        const id='recovery:'+key;
        const claim=await db.query('INSERT INTO attendance_direct.outbox(id,phone,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[id,phone,JSON.stringify(body)]);
        if(!claim.rows.length){duplicate++;continue;}
        try{
          const mid=await sendMeta(phone,body);
          await db.query("UPDATE attendance_direct.outbox SET state='accepted',message_id=$2 WHERE id=$1",[id,mid]);
          sent++;
        }catch(e){
          await db.query("UPDATE attendance_direct.outbox SET state='uncertain' WHERE id=$1",[id]);
          review++;
        }
      }
      recoveryFinished=review===0;
      console.log('[attendance-direct/recovery-batch]',JSON.stringify({sent,duplicate,review,finished:recoveryFinished}));
    }catch(e){console.error('[attendance-direct/recovery-batch]',e.message);}
    finally{recoveryBusy=false;}
  };
  setTimeout(runRecovery,15000).unref();
  setInterval(runRecovery,5*60*1000).unref();
}
