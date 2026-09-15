import test from 'node:test';
import assert from 'node:assert/strict';
import {nextScheduledTouch,scheduleTimes,formatChile,zonedEpoch} from './schedule.js';

const apt={date:'2026-09-21',time:'10:00',appointmentStatus:'Agendado',responseState:'none',sent:{}};
const at=(d,t)=>zonedEpoch(d,t);

test('421486 schedule is T-72, T-24 and 07:00 Chile',()=>{
  const s=scheduleTimes(apt);
  assert.equal(formatChile(s.appointmentAt),'21-09-2026, 10:00');
  assert.equal(formatChile(s.t72),'18-09-2026, 10:00');
  assert.equal(formatChile(s.t24),'20-09-2026, 10:00');
  assert.equal(formatChile(s.day07),'21-09-2026, 07:00');
});

test('before T-72 sends nothing',()=>{
  assert.deepEqual(nextScheduledTouch(apt,{now:at('2026-09-18','09:59')}).action,'none');
});

test('T-72 asks for confirmation',()=>{
  const r=nextScheduledTouch(apt,{now:at('2026-09-18','10:00')});
  assert.equal(r.action,'t72_confirmation');assert.equal(r.mode,'ask_confirmation');
});

test('T-24 retries confirmation when patient did not answer',()=>{
  const r=nextScheduledTouch({...apt,sent:{t72:true}},{now:at('2026-09-20','10:00')});
  assert.equal(r.action,'t24_confirmation');assert.equal(r.mode,'ask_confirmation');
});
test('T-24 is informational when already confirmed',()=>{
  const r=nextScheduledTouch({...apt,responseState:'confirmed',sent:{t72:true}},{now:at('2026-09-20','10:00')});
  assert.equal(r.action,'t24_reminder');assert.equal(r.mode,'informational');
});

test('07:00 day-of is informational even without prior response',()=>{
  const r=nextScheduledTouch({...apt,sent:{t72:true,t24:true}},{now:at('2026-09-21','07:00')});
  assert.equal(r.action,'day07_reminder');assert.equal(r.mode,'informational');
});

test('cancelled appointment receives no later messages',()=>{
  const r=nextScheduledTouch({...apt,appointmentStatus:'Cancelada',sent:{t72:true}},{now:at('2026-09-20','10:00')});
  assert.equal(r.action,'none');assert.equal(r.reason,'terminal_or_paused');
});

test('rescheduling and rescheduled old appointments are silent',()=>{
  for(const responseState of ['rescheduling','rescheduled']){
    const r=nextScheduledTouch({...apt,responseState},{now:at('2026-09-20','10:00')});
    assert.equal(r.action,'none');assert.equal(r.reason,'terminal_or_paused');
  }
});

test('sent stage is idempotent and does not resend',()=>{
  const r=nextScheduledTouch({...apt,sent:{t72:true}},{now:at('2026-09-18','10:30')});
  assert.equal(r.action,'none');assert.equal(r.reason,'t72_already_sent');
});
