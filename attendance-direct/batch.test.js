import test from 'node:test';
import assert from 'node:assert/strict';
import { chileDate, runTomorrowBatch, runTodayBatch } from './batch.js';

const raw=(id,status='Agendado',phone='+56 9 1111 1111')=>({
  id,fecha:'2026/09/17',hora:id===2?'10:30':'09:30',tipo:'Evaluación',estado:{nombre:status},
  paciente:{nombres:'PACIENTE',paterno:String(id),run:`1.111.11${id}-${id}`,telefono:phone},
  profesional:{nombres:'Rodrigo',paterno:'Villagran Morales',run:'13.580.388-k'},
  sucursal:{id:39,nombre:'Antofagasta Mall Arauco Express'}
});
const now=new Date('2026-09-16T13:00:00Z');
const poolFor=(appointments,syncedAt='2026-09-16T12:50:00Z')=>({query:async()=>({rows:[{appointments,synced_at:syncedAt}]})});

test('Chile calendar date resolves tomorrow without using server timezone',()=>{
  assert.equal(chileDate(now,1),'2026-09-17');
});

test('tomorrow batch previews only eligible appointments',async()=>{
  const result=await runTomorrowBatch({pool:poolFor([raw(1),raw(2,'Cancelada')]),now,commit:false});
  assert.equal(result.date,'2026-09-17');
  assert.equal(result.total,2);assert.equal(result.eligible,1);assert.equal(result.ineligible,1);
  assert.deepEqual(result.appointmentIds,[1]);assert.equal(result.preview,true);
});

test('committed batch is idempotency-aware and groups same-phone collisions',async()=>{
  const calls=[];
  const requestFn=async(a,opts)=>{calls.push({a,opts});if(a.id===2)throw Error('phone_has_current_request');return {duplicate:false};};
  const result=await runTomorrowBatch({pool:poolFor([raw(1),raw(2)]),requestFn,now,commit:true});
  assert.equal(result.sent,1);assert.equal(result.grouped,1);assert.equal(result.review,0);
  assert.match(calls[0].opts.key,/^daily20-20260917-1-/);assert.equal(calls[0].opts.actor,'daily-20h');
});

test('stale snapshot fails closed before any send',async()=>{
  await assert.rejects(runTomorrowBatch({pool:poolFor([raw(1)],'2026-09-16T11:00:00Z'),now,commit:true}),/tomorrow_snapshot_stale/);
});


test('today catch-up captures same-day active appointments and stays idempotent by request layer',async()=>{
  const item=raw(3);item.fecha='2026/09/16';item.hora='14:30';
  const calls=[];
  const requestFn=async(a,opts)=>{calls.push({a,opts});return {duplicate:false};};
  const result=await runTodayBatch({pool:poolFor([item]),requestFn,now,commit:true});
  assert.equal(result.date,'2026-09-16');
  assert.equal(result.sent,1);
  assert.equal(calls[0].opts.actor,'same-day-catchup');
  assert.match(calls[0].opts.key,/^same-day-catchup-20260916-3-/);
});
