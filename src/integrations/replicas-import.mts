import {randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Principal,SessionBatch} from '../sessions/types.mjs';
import type {SourceCard} from '../application/types.mjs';
import {sealedEnvelope} from './credential-vault.mjs';
import {replicasApi,replicasError,type ReplicasConversation} from './replicas-api.mjs';
import {replicasDigest,replicasEvents,replicasHarness} from './replicas-events.mjs';

export interface ReplicasImportStatus {
  id:string;organization:{id:string;name:string};phase:'preview'|'importing'|'complete'|'disconnected';
  total:number;processed:number;imported:number;skipped:number;unavailable:number;unsupported:number;messages:number;updatedAt:string;
  sample:Array<{title:string;workspace:string;provider:string|null}>;
}
export interface ReplicasImportInput {action:'preview'|'start'|'step'|'disconnect';apiKey?:string;id?:string}
interface State extends ReplicasImportStatus {queue:ReplicasConversation[];next:string|null;before:string|null;listCursors:string[];historyCursors:string[];chatMessages:number}
export type ReplicasImport=ReturnType<typeof createReplicasImport>;

/** Each explicit step handles one API page. PostgreSQL serializes callers and
 * checkpoints only after the normal session ingest has durably dispatched it.
 * Closing the page pauses work; any admin can resume the persisted checkpoint. */
export function createReplicasImport({database,key,ingest,request=fetch}:{database:ApplicationDatabase;key:Uint8Array;ingest:(principal:Principal,batch:SessionBatch)=>Promise<unknown>;request?:typeof fetch}){
  const envelope=sealedEnvelope(key),namespace=database.namespace;
  let prepared:Promise<void>|undefined;
  const ready=()=>prepared??=database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas-import:schema',0))");
    await client.query('CREATE TABLE IF NOT EXISTS opencrawl_replicas_imports(namespace text NOT NULL,tenant text NOT NULL,state jsonb NOT NULL,credential bytea,PRIMARY KEY(namespace,tenant))');
  }).catch(error=>{prepared=undefined;throw error;});
  function visible(state:State):ReplicasImportStatus{const {id,organization,phase,total,processed,imported,skipped,unavailable,unsupported,messages,updatedAt,sample}=state;return {id,organization,phase,total,processed,imported,skipped,unavailable,unsupported,messages,updatedAt,sample};}
  async function status(principal:Principal){await ready();const row=(await database.pool.query('SELECT state FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[namespace,principal.tenantId])).rows[0];return row?visible(row.state as State):null;}
  async function action(principal:Principal,input:ReplicasImportInput):Promise<ReplicasImportStatus>{
    await ready();
    return database.transaction(async client=>{
      const path=JSON.stringify([namespace,principal.tenantId]);
      const lock=await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['replicas-import:'+path]);
      if(!lock.rows[0]?.acquired)throw replicasError('Another import request is running. Try again shortly.',409);
      const row=(await client.query('SELECT state,credential FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[namespace,principal.tenantId])).rows[0];
      let state:State|undefined=row?.state,credential:Buffer|null=row?.credential??null;
      if(input.action==='preview'){
        if(state?.phase==='importing')throw replicasError('Pause and remove the current key before starting another import.',409);
        const apiKey=input.apiKey?.trim();if(!apiKey||apiKey.length>4000||/[\r\n]/.test(apiKey))throw replicasError('Enter a Replicas organization API key.');
        const api=replicasApi(apiKey,request),identity=await api.identity();
        if(identity.caller!=='organization_api_key')throw replicasError('Historical import requires a Replicas organization API key. Personal keys and CLI login tokens do not work.');
        const page=await api.conversations();
        state={id:randomUUID(),organization:identity.organization,phase:'preview',total:page.total,processed:0,imported:0,skipped:0,unavailable:0,unsupported:0,messages:0,updatedAt:new Date().toISOString(),sample:page.conversations.slice(0,5).map(chat=>({title:chat.title??'Untitled chat',workspace:chat.workspace_name,provider:chat.provider})),queue:page.conversations,next:page.next_cursor,before:null,listCursors:[],historyCursors:[],chatMessages:0};
        credential=envelope.seal(path,Buffer.from(apiKey));
      }else{
        if(!state||state.id!==input.id)throw replicasError('This import changed. Reload Integrations before continuing.',409);
        if(input.action==='disconnect'){credential=null;state.phase='disconnected';state.queue=[];state.next=null;state.before=null;}
        if(input.action==='start'){
          if(state.phase!=='preview')throw replicasError('Preview this import before starting.',409);
          state.phase='importing';
        }
        if(input.action==='step'&&state.phase!=='complete'){
          if(state.phase!=='importing'||!credential)throw replicasError('Preview and approve the import before reading history.',409);
          const api=replicasApi(envelope.open(path,credential).toString(),request);
          const chat=state.queue[0];
          if(chat){
            const harness=replicasHarness(chat.provider);
            if(!harness){state.skipped++;state.unsupported++;state.processed++;state.queue.shift();}
            else{
              let history;
              try{history=await api.history(chat,state.before);}catch(error){if(!state.before&&error instanceof Error&&'status' in error&&[404,409].includes(Number(error.status))){state.skipped++;state.unavailable++;state.processed++;state.queue.shift();state.before=null;state.historyCursors=[];state.chatMessages=0;}else throw error;}
              if(history){
                const next=history.before_cursor;
                if(next&&(next===state.before||state.historyCursors.includes(replicasDigest(next))))throw replicasError('Replicas repeated a history cursor. The import paused safely.',502);
                if(history.has_more===true&&!next)throw replicasError('Replicas omitted the next history cursor. Resume to retry.',502);
                const events=replicasEvents(chat,history);
                if(events.length){
                  const owner={tenantId:principal.tenantId,userId:'workload_replicas_'+replicasDigest('history-v1:'+state.organization.id+':'+chat.workspace_id)};
                  await ingest(owner,{schemaVersion:1,installationId:'replicas-history-v1:'+state.organization.id,sessionId:'replicas-chat:'+chat.chat_id,harness,origin:'cloud',captureMode:'history',owner,title:'[Replicas history] '+(chat.title??chat.workspace_name),events,attachments:[]});
                  state.messages+=events.length;state.chatMessages+=events.length;
                }
                if(next){state.before=next;state.historyCursors.push(replicasDigest(next));}
                else{state.processed++;if(state.chatMessages)state.imported++;else state.skipped++;state.queue.shift();state.before=null;state.historyCursors=[];state.chatMessages=0;}
              }
            }
          }else if(state.next){
            const cursor=state.next,hash=replicasDigest(cursor);
            if(state.listCursors.includes(hash))throw replicasError('Replicas repeated an export cursor. The import paused safely.',502);
            const page=await api.conversations(cursor);state.queue=page.conversations;state.next=page.next_cursor;state.listCursors.push(hash);
          }
          if(!state.queue.length&&!state.next){state.phase='complete';credential=null;}
        }
      }
      state.updatedAt=new Date().toISOString();
      await client.query('INSERT INTO opencrawl_replicas_imports(namespace,tenant,state,credential) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(namespace,tenant) DO UPDATE SET state=EXCLUDED.state,credential=EXCLUDED.credential',[namespace,principal.tenantId,JSON.stringify(state),credential]);
      return visible(state);
    });
  }
  async function source(principal:Principal):Promise<SourceCard>{
    const history=await status(principal);
    return {provider:'replicas',name:'Replicas',description:'Import retained Claude and Codex conversations directly from your Replicas organization.',auth:'api-key',scope:'team',state:history?'connected':'disconnected',account:history?.organization.name,primaryMetric:'Chats imported',rows:history?[{label:'Chats imported',count:history.imported},{label:'Chats skipped',count:history.skipped}]:[],history:history??undefined};
  }
  return {status,action,source};
}
