import { getPool } from '../chatwoot-webhook/db.js';
import { readAppointment } from '../attendance/clients.js';
import { eligible } from '../attendance/policy.js';
import { sendMeta } from './meta.js';

export const CREATED_TEMPLATE = 'cly_appointment_created_v1';
export const creationOutboxSchema = `CREATE TABLE IF NOT EXISTS public.appointment_creation_outbox (
  appointment_id bigint PRIMARY KEY,
  appointment jsonb NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending',
  claimed_at timestamptz,
  message_id text,
  sent_at timestamptz,
  error text
)`;

const ready=new WeakMap();
export async function ensureCreationOutbox(pool=getPool()){
  if(!pool)throw Error('creation_database_unavailable');
  if(!ready.has(pool))ready.set(pool,pool.query(creationOutboxSchema).catch(e=>{ready.delete(pool);throw e;}));
  return ready.get(pool);
}

const firstName=name=>String(name||'').trim().split(/\s+/)[0]||'Paciente';
export function creationTemplate(a){
  const values=[firstName(a.patient),a.type||'consulta',a.professional,a.date.split('-').reverse().join('/'),a.time,a.branch||'Clínyco'];
  return {type:'template',template:{name:CREATED_TEMPLATE,language:{code:'es_CL'},components:[{type:'body',parameters:values.map(text=>({type:'text',text:String(text)}))}]}};
}

async function claimOne(pool){
  const {rows}=await pool.query(`UPDATE public.appointment_creation_outbox q SET state='sending',claimed_at=now(),error=NULL
    WHERE q.appointment_id=(SELECT appointment_id FROM public.appointment_creation_outbox WHERE state='pending' ORDER BY detected_at,appointment_id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  return rows[0]||null;
}

export async function processCreatedAppointments({pool=getPool(),send=sendMeta,read=readAppointment,now=new Date(),limit=20}={}){
  if(process.env.APPOINTMENT_CREATED_WHATSAPP_ENABLED!=='true')return {enabled:false,processed:0,sent:0,skipped:0,review:0};
  await ensureCreationOutbox(pool);
  await pool.query(`UPDATE public.appointment_creation_outbox SET state='review',error='interrupted_send' WHERE state='sending' AND claimed_at<now()-interval '10 minutes'`);
  const summary={enabled:true,processed:0,sent:0,skipped:0,review:0};
  for(let i=0;i<Math.max(1,Math.min(Number(limit)||20,100));i++){
    const row=await claimOne(pool);if(!row)break;summary.processed++;
    try{
      const raw=row.appointment||{};
      const id=Number(row.appointment_id);
      if(!Number.isSafeInteger(id)||id<1)throw Error('invalid_appointment_id');
      const fresh=await read(id);
      if(!eligible(fresh,now)){
        await pool.query("UPDATE public.appointment_creation_outbox SET state='skipped',error='appointment_not_active' WHERE appointment_id=$1",[id]);summary.skipped++;continue;
      }
      const mid=await send(fresh.phone,creationTemplate(fresh));
      await pool.query("UPDATE public.appointment_creation_outbox SET state='sent',message_id=$2,sent_at=now(),error=NULL WHERE appointment_id=$1",[id,mid]);summary.sent++;
    }catch(error){
      await pool.query("UPDATE public.appointment_creation_outbox SET state='review',error=$2 WHERE appointment_id=$1",[row.appointment_id,String(error?.message||'send_failed').slice(0,180)]);summary.review++;
    }
  }
  return summary;
}
