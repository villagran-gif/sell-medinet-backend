import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshot,eligible,parseEvent,selectRequest,decision,acknowledgment} from './policy.js';
import {parseRoutingConfig,resolveHandlerKeys} from '../chatwoot-dispatcher/routing.js';
const now=new Date('2026-09-14T14:00:00Z');
const raw={id:10,paciente:{id:12,nombres:'Paciente',paterno:'Real',telefono:'+56911111111'},profesional:{id:3,nombres:'Doctor',paterno:'Prueba'},sucursal:{id:39,nombre:'Antofagasta'},fecha:'2026-09-15',hora:'12:40',tipo:'Telemedicina',estado:{nombre:'Agendado'}};
test('snapshot prefers a valid Chilean mobile from secondary phone',()=>{
 const a=snapshot({...raw,paciente:{...raw.paciente,telefono:'+56 9 9994 934_',telefono_2:'+56 9 9994 4934'}});
 assert.equal(a.phone,'56999944934');
});

test('strict appointment identity and status/fingerprint separation',()=>{
 const a=snapshot(raw);assert.equal(eligible(a,now),true);
 assert.equal(snapshot({...raw,estado:{nombre:'Confirmado'}}).fingerprint,a.fingerprint);
 assert.notEqual(snapshot({...raw,hora:'13:00'}).fingerprint,a.fingerprint);
 assert.throws(()=>snapshot({...raw,paciente:{nombres:'Sin identidad'}}),/identity/);
 for(const status of ['Cancelada','Re-Agendado','Atendido'])assert.equal(eligible(snapshot({...raw,estado:{nombre:status}}),now),false);
 assert.equal(eligible(snapshot({...raw,paciente:{...raw.paciente,nombres:'Paciente Prueba'}}),now),false);
 assert.equal(eligible(snapshot({...raw,fecha:'2026-09-13'}),now),false);
});

test('Medinet snapshots may omit numeric patient/professional ids but retain stable identity',()=>{
 const medinet={...raw,paciente:{nombres:'Paciente',paterno:'Real',telefono:'+56911111111',run:'19.395.918-0'},profesional:{nombres:'Doctor',paterno:'Prueba',run:'13.580.388-k'}};
 const a=snapshot(medinet);assert.equal(a.patientId,null);assert.equal(a.professionalId,null);assert.equal(a.professionalRun,'13.580.388-k');assert.equal(eligible(a,now),true);
 assert.equal(snapshot({...medinet,estado:{nombre:'Confirmado'}}).fingerprint,a.fingerprint);
 assert.notEqual(snapshot({...medinet,profesional:{...medinet.profesional,run:'15.020.022-9'}}).fingerprint,a.fingerprint);
});
test('dedicated route activates only on exact account and inbox',()=>{
 const p={account:{id:162472},conversation:{id:399,inbox_id:107690}};
 assert.deepEqual(resolveHandlerKeys(p,parseRoutingConfig({})),['antonia']);
 const cfg=parseRoutingConfig({ATTENDANCE_ENABLED:'true'});assert.deepEqual(resolveHandlerKeys(p,cfg),['attendance']);
 assert.deepEqual(resolveHandlerKeys({...p,account:{id:2}},cfg),['antonia']);
 assert.deepEqual(resolveHandlerKeys({...p,conversation:{inbox_id:110652}},cfg),['antonia']);
});
test('quoted and unquoted replies never pick a first appointment among multiple',()=>{
 const r={id:1,phone:'56911111111',conversation_id:50,message_id:100,sent_at:'2026-09-14T12:00:00Z',expires_at:'2026-09-16T12:00:00Z'};
 const m={phone:r.phone,conversationId:'50',createdAt:now};
 assert.equal(selectRequest([r],m,now),r);
 assert.equal(selectRequest([r,{...r,id:2,message_id:101}],m,now),null);
 assert.equal(selectRequest([r,{...r,id:2,message_id:101}],{...m,replyTo:'100'},now),r);
 assert.equal(selectRequest([r],{...m,replyTo:'999'},now),null);
 assert.equal(selectRequest([r],{...m,phone:'56922222222'},now),null);
 assert.equal(selectRequest([r],{...m,createdAt:new Date('2026-09-13')},now),null);
});
test('No, Reagendar, Si does not reopen or reconfirm a cancelled appointment',()=>{
 assert.equal(decision('pending','cancel'),'cancel');assert.equal(decision('cancel','reschedule'),'human');
 assert.equal(decision('human','confirm'),'human');assert.equal(decision('confirm','confirm'),'duplicate');
 assert.equal(decision('pending','other'),'human');assert.equal(decision('uncertain','confirm'),'human');
});
test('only a verified receipt permits an agenda success message',()=>{
 assert.match(acknowledgment('confirm',true),/quedó confirmada/);
 assert.doesNotMatch(acknowledgment('confirm',false),/quedó confirmada/);
 assert.match(acknowledgment('confirm',true,true),/No se modificó ninguna cita real/);
});
test('event parsing validates account and accepts normal replies without a quote',()=>{
 const p={event:'message_created',account:{id:162472},conversation:{id:50,inbox_id:107690},id:100,message_type:'incoming',created_at:now.toISOString(),content:'Sí',sender:{phone_number:'+56911111111'}};
 assert.equal(parseEvent(p).incoming,true);assert.equal(parseEvent(p).replyTo,null);
 assert.equal(parseEvent({...p,account:{id:1}}),null);
 assert.equal(parseEvent({...p,private:true}).incoming,false);
});

test('resource exam appointment without professional uses stable Clinyco identity',()=>{
 const resource={...raw,id:421495,tipo:'Bio impedanciometria',profesional:{},estado:{nombre:'Confirmado'}};
 const a=snapshot(resource);
 assert.equal(a.professional,'Clinyco');assert.equal(a.resourceAppointment,true);assert.equal(eligible(a,now),true);
 assert.equal(snapshot({...resource,estado:{nombre:'Agendado'}}).fingerprint,a.fingerprint);
});
