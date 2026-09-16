import test from 'node:test';
import assert from 'node:assert/strict';
import { creationTemplate, processCreatedAppointments, CREATED_TEMPLATE } from './created.js';

test('appointment-created template contains exact booking facts and no action buttons',()=>{
  const body=creationTemplate({patient:'María José Ávila',type:'Control Post-Operatorio de Cirugía',professional:'Rodrigo Villagran Morales',date:'2026-09-17',time:'11:40',branch:'Antofagasta Mall Arauco Express'});
  assert.equal(body.type,'template');
  assert.equal(body.template.name,CREATED_TEMPLATE);
  assert.equal(body.template.language.code,'es_CL');
  assert.equal(body.template.components.length,1);
  assert.deepEqual(body.template.components[0].parameters.map(x=>x.text),['María','Control Post-Operatorio de Cirugía','Rodrigo Villagran Morales','17/09/2026','11:40','Antofagasta Mall Arauco Express']);
});

test('appointment-created processor fails closed while feature flag is disabled',async()=>{
  const old=process.env.APPOINTMENT_CREATED_WHATSAPP_ENABLED;
  delete process.env.APPOINTMENT_CREATED_WHATSAPP_ENABLED;
  try{
    const result=await processCreatedAppointments({pool:{query:async()=>{throw Error('must not query');}}});
    assert.deepEqual(result,{enabled:false,processed:0,sent:0,skipped:0,review:0});
  }finally{
    if(old===undefined)delete process.env.APPOINTMENT_CREATED_WHATSAPP_ENABLED;else process.env.APPOINTMENT_CREATED_WHATSAPP_ENABLED=old;
  }
});
