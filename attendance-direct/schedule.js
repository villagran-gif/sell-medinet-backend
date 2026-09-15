const TZ = 'America/Santiago';
const HOUR = 3600_000;

function localParts(date, time='00:00') {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date||''));
  const tm = /^(\d{2}):(\d{2})/.exec(String(time||''));
  if (!dm || !tm) throw new Error('invalid_local_datetime');
  return {year:+dm[1], month:+dm[2], day:+dm[3], hour:+tm[1], minute:+tm[2]};
}

function offsetAt(epochMs, timeZone=TZ) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
  }).formatToParts(new Date(epochMs)).map(p=>[p.type,p.value]));
  const localAsUtc = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
  return localAsUtc - epochMs;
}

export function zonedEpoch(date, time, timeZone=TZ) {
  const p=localParts(date,time);
  const wall=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,0);
  let epoch=wall;
  for(let i=0;i<3;i++) epoch=wall-offsetAt(epoch,timeZone);
  return epoch;
}
function terminalOrPaused({appointmentStatus,responseState}) {
  const apt=String(appointmentStatus||'').toLowerCase();
  const response=String(responseState||'none').toLowerCase();
  if (['cancelada','cancelado','anulada','anulado'].includes(apt)) return true;
  return ['cancelled','canceled','rescheduling','rescheduled','needs_review','human'].includes(response);
}

export function scheduleTimes({date,time,timeZone=TZ}) {
  const appointmentAt=zonedEpoch(date,time,timeZone);
  return {
    appointmentAt,
    t72:appointmentAt-72*HOUR,
    t24:appointmentAt-24*HOUR,
    day07:zonedEpoch(date,'07:00',timeZone),
  };
}

export function nextScheduledTouch(input,{now=Date.now(),timeZone=TZ}={}) {
  const nowMs=now instanceof Date?now.getTime():Number(now);
  const sent=input.sent||{};
  const response=String(input.responseState||'none').toLowerCase();
  const confirmed=response==='confirmed'||String(input.appointmentStatus||'').toLowerCase()==='confirmado';
  if (terminalOrPaused(input)) return {action:'none',reason:'terminal_or_paused'};
  const times=scheduleTimes({...input,timeZone});
  if (nowMs>=times.appointmentAt) return {action:'none',reason:'appointment_started'};

  if (times.day07<times.appointmentAt && nowMs>=times.day07) {
    if (sent.day07) return {action:'none',reason:'day07_already_sent'};
    return {action:'day07_reminder',mode:'informational',dueAt:times.day07};
  }
  if (nowMs>=times.t24) {
    if (sent.t24) return {action:'none',reason:'t24_already_sent'};
    return confirmed
      ? {action:'t24_reminder',mode:'informational',dueAt:times.t24}
      : {action:'t24_confirmation',mode:'ask_confirmation',dueAt:times.t24};
  }
  if (nowMs>=times.t72) {
    if (sent.t72) return {action:'none',reason:'t72_already_sent'};
    if (confirmed) return {action:'none',reason:'already_confirmed_before_t72'};
    return {action:'t72_confirmation',mode:'ask_confirmation',dueAt:times.t72};
  }
  return {action:'none',reason:'not_due'};
}

export function formatChile(epochMs) {
  return new Intl.DateTimeFormat('es-CL',{
    timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23'
  }).format(new Date(epochMs));
}
