import { getPool } from '../chatwoot-webhook/db.js';
import { eligible, snapshot as normalizeAppointment } from '../attendance/policy.js';
import { request } from './engine.js';

export function chileDate(now=new Date(),days=0){
  const ymd=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const [y,m,d]=ymd.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d+days,12)).toISOString().slice(0,10);
}

export async function runDateBatch({days=0,pool=getPool(),requestFn=request,now=new Date(),commit=false,maxSnapshotAgeMs=30*60*1000,actor}={}){
  const date=chileDate(now,days);
  const label=days===1?'tomorrow':days===0?'today':`day_${days}`;
  const {rows}=await pool.query(`SELECT appointments,synced_at FROM public.medinet_daily_snapshots WHERE day=$1::date ORDER BY synced_at DESC LIMIT 1`,[date]);
  if(!rows.length)throw Error(`${label}_snapshot_missing`);
  const syncedAt=new Date(rows[0].synced_at);
  if(!Number.isFinite(syncedAt.valueOf()) || now.valueOf()-syncedAt.valueOf()>maxSnapshotAgeMs)throw Error(`${label}_snapshot_stale`);
  const raw=rows[0].appointments;
  if(!Array.isArray(raw))throw Error(`${label}_snapshot_invalid`);
  const items=[];let invalid=0,ineligible=0;
  for(const item of raw){
    try{const a=normalizeAppointment(item);if(a.date===date&&eligible(a,now))items.push(a);else ineligible++;}
    catch{invalid++;}
  }
  items.sort((a,b)=>a.time.localeCompare(b.time)||a.id-b.id);
  const summary={date,snapshotSyncedAt:syncedAt.toISOString(),total:raw.length,eligible:items.length,invalid,ineligible,sent:0,duplicate:0,grouped:0,review:0,skipped:0,preview:!commit};
  if(!commit)return {...summary,appointmentIds:items.map(a=>a.id)};
  const effectiveActor=actor||(days===1?'daily-20h':'same-day-catchup');
  for(const a of items){
    try{
      const key=`${effectiveActor}-${date.replaceAll('-','')}-${a.id}-${a.fingerprint.slice(0,12)}`;
      const result=await requestFn(a,{trial:false,key,actor:effectiveActor,now});
      if(result?.duplicate)summary.duplicate++;else summary.sent++;
    }catch(error){
      if(error?.message==='phone_has_current_request')summary.grouped++;
      else if(error?.message==='appointment_changed')summary.skipped++;
      else summary.review++;
    }
  }
  return summary;
}

export const runTomorrowBatch=(options={})=>runDateBatch({...options,days:1,actor:options.actor||'daily-20h'});
export const runTodayBatch=(options={})=>runDateBatch({...options,days:0,actor:options.actor||'same-day-catchup'});
