const base=String(process.env.ATTENDANCE_BACKEND_URL||'https://sell-medinet-backend.onrender.com').replace(/\/+$/,'');
const token=String(process.env.CONFIRMATIONS_INTAKE_TOKEN||'').trim();
if(!token)throw Error('CONFIRMATIONS_INTAKE_TOKEN missing');
const now=new Date();
const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Santiago',hour:'2-digit',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value]));
const hour=Number(parts.hour);
const endpoints=[];
if(hour>=7&&hour<=18)endpoints.push('batch-today');
if(hour===20)endpoints.push('batch-tomorrow');
if(!endpoints.length){console.log(JSON.stringify({skipped:true,chileHour:hour,date:`${parts.year}-${parts.month}-${parts.day}`}));process.exit(0);}
for(const endpoint of endpoints){
  const response=await fetch(`${base}/attendance-direct/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({commit:true}),signal:AbortSignal.timeout(120000)});
  const data=await response.json().catch(()=>({error:'invalid_json'}));
  if(!response.ok)throw Error(`${endpoint}_${response.status}_${data.error||'failed'}`);
  console.log(JSON.stringify({endpoint,chileHour:hour,...data}));
}
