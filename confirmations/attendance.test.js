import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {extractAttendanceReply} from './reply-context.js';
import {classifyInbound} from './classifier.js';
import {buildAckText} from './acknowledgments.js';

for(const [intent,texts] of Object.entries({
  confirm:['Sí','confirmo','ahí estaré','Confirmo la hora'],
  cancel:['cancelo','no puedo asistir','no voy'],
  reschedule:['¿Puede ser más tarde?','¿Podría ser más temprano?','No puedo, quiero cambiar la hora'],
  other:['¿Dónde queda?','¿cuánto cuesta?','¿Confirmo por aquí?','¿Cancelo por aquí?','Confirmo, ¿cuánto cuesta?'],
  ambiguous:['No confirmo','No puedo','confirmo si puedo','sí, pero no confirmo todavía','quizás asistiré']
})) for(const text of texts) test(`attendance intent: ${text}`,async()=>assert.equal((await classifyInbound(text)).intent,intent));

const apt={id:1,external_id:10,state:'confirmed',patient_name:'Paciente Sintético',appointment_at:'2026-10-20T14:00:00Z',chatwoot_conversation_id:11};
test('local acceptance cannot claim Medinet confirmation, even with an imported confirmed state',()=>{
  const text=buildAckText({...apt,medinet_state:'Confirmado'},'confirm');
  assert.match(text,/registramos que asistirás/);assert.match(text,/No tengo comprobante/);
  assert.doesNotMatch(text,/cita queda confirmada/);
});
test('local cancellation request cannot claim an executed cancellation',()=>{
  const text=buildAckText({...apt,state:'cancelled'},'cancel');
  assert.match(text,/solicitud de cancelación/);assert.match(text,/No tengo comprobante/);
  assert.doesNotMatch(text,/cita queda cancelada/);
});
test('reschedule acknowledgment promises neither availability nor a completed change',()=>{
  const text=buildAckText({...apt,state:'reschedule_requested'},'reschedule');
  assert.match(text,/no modifica la cita original/);assert.doesNotMatch(text,/Déjame buscar|En instantes|queda reagendada/);
});
test('acknowledgment requires the corresponding persisted response state',()=>{
  assert.equal(buildAckText(null,'confirm'),null);
  assert.equal(buildAckText({...apt,state:'first_msg_sent'},'confirm'),null);
  assert.equal(buildAckText(apt,'cancel'),null);
  assert.equal(buildAckText(apt,'other'),null);
});
const source=readFileSync(new URL('./inbound-processor.js',import.meta.url),'utf8')
  .replace(/^import[\s\S]*?;\n/gm,'').replace(/export async function/g,'async function');
function handler({update,find=async()=>apt}) {
  let acks=0,classified=0;
  const run=vm.runInNewContext(source+'\nhandleInboundEvent',{
    console,process:{env:{}},classifyInbound,INTENTS:{RESCHEDULE:'reschedule'},
    extractAttendanceReply,findAppointmentByReply:find,logClassification:async()=>{classified++},applyIntent:update,
    sendAcknowledgment:async()=>{acks++;return {sent:true}}
  });
  return {run:()=>run({id:1,payload:{account:{id:162472},id:20,event:'message_created',content_attributes:{in_reply_to:10},message_type:'incoming',content:'Confirmo',sender:{phone_number:'+56911111111'},conversation:{id:11,inbox_id:110652}}}),get acks(){return acks},get classified(){return classified}};
}
test('zero-row update emits no acknowledgment or reschedule handoff',async()=>{
  const f=handler({update:async()=>null});const r=await f.run();
  assert.equal(r.reason,'appointment_update_unverified');assert.equal(f.acks,0);assert.equal(r.handoff,false);
});
test('database write failure emits no success acknowledgment',async()=>{
  const f=handler({update:async()=>{throw Error('synthetic write failure')}});
  await assert.rejects(f.run(),/synthetic write failure/);assert.equal(f.acks,0);
});
test('no pending appointment does not consume an unrelated message',async()=>{
  const f=handler({find:async()=>null,update:async()=>{throw Error('must not write')}});
  assert.equal((await f.run()).reason,'no_pending_confirmation');assert.equal(f.classified,0);assert.equal(f.acks,0);
});
