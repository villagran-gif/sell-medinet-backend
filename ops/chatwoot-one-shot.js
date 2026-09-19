import { getPool } from '../chatwoot-webhook/db.js';
import { postPublicMessage, toggleConversationStatus } from '../chatwoot-webhook/lib/chatwoot-api.js';

const raw=String(process.env.CHATWOOT_ONE_SHOT_JSON||'').trim();
if(raw){
  setTimeout(async()=>{
    let key='';
    try{
      const job=JSON.parse(raw);
      key=String(job?.key||'').trim();
      const conversationId=Number(job?.conversationId);
      const message=String(job?.message||'').trim();
      const resolve=job?.resolve===true;
      if(!/^[a-zA-Z0-9_-]{8,100}$/.test(key)||!Number.isSafeInteger(conversationId)||conversationId<1||!message) throw Error('invalid_chatwoot_one_shot');
      const db=getPool();
      await db.query(`CREATE TABLE IF NOT EXISTS public.ops_once_actions (
        action_key text PRIMARY KEY,
        state text NOT NULL DEFAULT 'processing',
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        error text
      )`);
      const claim=await db.query('INSERT INTO public.ops_once_actions(action_key) VALUES($1) ON CONFLICT DO NOTHING RETURNING action_key',[key]);
      if(!claim.rows.length){console.log('[chatwoot-one-shot]',JSON.stringify({key,duplicate:true}));return;}
      await postPublicMessage(conversationId,message);
      if(resolve) await toggleConversationStatus(conversationId,'resolved');
      await db.query("UPDATE public.ops_once_actions SET state='done',finished_at=now() WHERE action_key=$1",[key]);
      console.log('[chatwoot-one-shot]',JSON.stringify({key,conversationId,sent:true,resolved:resolve}));
    }catch(e){
      if(key){
        try{await getPool().query("UPDATE public.ops_once_actions SET state='error',error=$2,finished_at=now() WHERE action_key=$1",[key,String(e.message).slice(0,300)]);}catch{}
      }
      console.error('[chatwoot-one-shot]',JSON.stringify({key,error:e.message}));
    }
  },7000).unref();
}
