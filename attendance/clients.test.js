import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceMedinetProxy} from './clients.js';

test('attendance Medinet proxy uses MelanIA handoff endpoint, never direct Medinet',async()=>{
 let seen;const env={CLINYCO_AI_BASE_URL:'https://clinyco-ai.example/',CLINYCO_AI_HANDOFF_TOKEN:'synthetic'};
 const appointment={id:421423,estado:{nombre:'Confirmado'}};
 const result=await attendanceMedinetProxy('confirm',421423,{env,fetchImpl:async(url,opts)=>{seen={url,opts};return {ok:true,status:200,json:async()=>({success:true,appointment})};}});
 assert.equal(result,appointment);assert.equal(seen.url,'https://clinyco-ai.example/melania/appointment-direct');
 assert.equal(seen.opts.headers.Authorization,'Bearer synthetic');assert.deepEqual(JSON.parse(seen.opts.body),{appointmentId:421423,intent:'confirm'});
 assert.equal(seen.url.includes('medinetapp.com'),false);
});

test('attendance Medinet proxy fails closed on gateway error',async()=>{
 const env={CLINYCO_AI_BASE_URL:'https://clinyco-ai.example',CLINYCO_AI_HANDOFF_TOKEN:'synthetic'};
 await assert.rejects(attendanceMedinetProxy('read',421423,{env,fetchImpl:async()=>({ok:false,status:502,json:async()=>({error:'medinet_vps_unavailable'})})}),/melania_attendance_502/);
});
