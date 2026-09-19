import { getPool } from '../chatwoot-webhook/db.js';
import { eligible, snapshot as normalizeAppointment } from '../attendance/policy.js';
import { request } from './engine.js';
import { runTomorrowBatch, chileDate } from './batch.js';

const seen=new Set();

function chileClock(now=new Date()){
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).formatToParts(now).map(p=>[p.type,p.value]));
}

async function runTodayCatchup({pool=getPool(),requestFn=request,now=new Date(),maxSnapshotAgeMs=30*60*1000}={}){
  const date=chileDate(now,0);
  const {rows}=await pool.query(
    'SELECT appointments,synced_at FROM public.medinet_daily_snapshots WHERE day=$1::date ORDER BY synced_at DESC LIMIT 1',
    [date]
  );
  if(!rows.length)throw Error('today_snapshot_missing');
  const syncedAt=new Date(rows[0].synced_at);
  if(!Number.isFinite(syncedAt.valueOf())||now.valueOf()-syncedAt.valueOf()>maxSnapshotAgeMs)throw Error('today_snapshot_stale');
  const raw=rows[0].appointments;
  if(!Array.isArray(raw))throw Error('today_snapshot_invalid');
  const items=[];
  for(const item of raw){
    try{
      const a=normalizeAppointment(item);
      if(a.date===date&&eligible(a,now))items.push(a);
    }catch{}
  }
  items.sort((a,b)=>a.time.localeCompare(b.time)||a.id-b.id);
  const summary={date,eligible:items.length,sent:0,duplicate:0,grouped:0,review:0,skipped:0};
  for(const a of items){
    try{
      const result=await requestFn(a,{trial:false,key:`dayof-${date.replaceAll('-','')}-${a.id}-${a.fingerprint.slice(0,12)}`,actor:'dayof-catchup',now});
      if(result?.duplicate)summary.duplicate++;else summary.sent++;
    }catch(error){
      if(error?.message==='phone_has_current_request')summary.grouped++;
      else if(error?.message==='appointment_changed')summary.skipped++;
      else summary.review++;
    }
  }
  return summary;
}

export async function schedulerTick({now=new Date()}={}){
  const p=chileClock(now);
  const hour=Number(p.hour),minute=Number(p.minute);
  const date=`${p.year}-${p.month}-${p.day}`;

  if(hour===20){
    const key=`tomorrow:${date}`;
    if(!seen.has(key)){
      seen.add(key);
      try{
        const r=await runTomorrowBatch({commit:true,now});
        console.log('[attendance-direct/internal-scheduler/tomorrow]',JSON.stringify(r));
      }catch(e){seen.delete(key);console.error('[attendance-direct/internal-scheduler/tomorrow]',e.message);}
    }
  }

  if(hour>=7&&hour<=18){
    const key=`today:${date}:${hour}`;
    if(!seen.has(key)){
      seen.add(key);
      try{
        const r=await runTodayCatchup({now});
        console.log('[attendance-direct/internal-scheduler/today]',JSON.stringify(r));
      }catch(e){seen.delete(key);console.error('[attendance-direct/internal-scheduler/today]',e.message);}
    }
  }
}

export function startInternalAttendanceScheduler(){
  const run=()=>schedulerTick().catch(e=>console.error('[attendance-direct/internal-scheduler]',e.message));
  setTimeout(run,15000).unref();
  setInterval(run,5*60*1000).unref();
}

if(process.env.ATTENDANCE_DIRECT_ENABLED==='true'
  && process.env.ATTENDANCE_DIRECT_MODE==='live'
  && process.env.ATTENDANCE_DIRECT_INTERNAL_SCHEDULER_ENABLED==='true'){
  startInternalAttendanceScheduler();
  console.log('[attendance-direct/internal-scheduler] enabled');
}
