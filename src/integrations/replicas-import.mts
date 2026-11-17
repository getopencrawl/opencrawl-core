import {randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Principal,SessionBatch,SessionEvent} from '../sessions/types.mjs';
import type {SourceCard} from '../application/types.mjs';
import {sealedEnvelope} from './credential-vault.mjs';
import {replicasApi,replicasError,type ReplicasConversation} from './replicas-api.mjs';
import {replicasDigest,replicasEvents,replicasTurns} from './replicas-events.mjs';

export interface ReplicasImportStatus {
  id:string;organization:{id:string;name:string};phase:'preview'|'importing'|'complete'|'disconnected';
  total:number;processed:number;imported:number;events:number;turns:number;pages:number;updatedAt:string;
  sample:Array<{title:string;workspace:string;provider:string|null}>;
}
export interface ReplicasImportInput {action:'preview'|'start'|'step'|'disconnect';apiKey?:string;id?:string}
interface State extends ReplicasImportStatus {queue:ReplicasConversation[];next:string|null;before:string|null;listCursors:string[];historyCursors:string[];occurrences:Record<string,number>;completedSessions:string[]}
export type ReplicasImport=ReturnType<typeof createReplicasImport>;

/** One explicit step reads one complete API page. Checkpoint only after the
 * original response and every projected record reach durable ingest/indexing.
 * Missing access and unknown pagination fail closed; no conversation is skipped. */
export function createReplicasImport({database,key,ingest,request=fetch}:{database:ApplicationDatabase;key:Uint8Array;ingest:(principal:Principal,batch:SessionBatch)=>Promise<unknown>;request?:typeof fetch}){
  const envelope=sealedEnvelope(key),namespace=database.namespace;
  let prepared:Promise<void>|undefined;
  const ready=()=>prepared??=database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas-import:schema',0))");
    await client.query('CREATE TABLE IF NOT EXISTS opencrawl_replicas_imports(namespace text NOT NULL,tenant text NOT NULL,state jsonb NOT NULL,credential bytea,PRIMARY KEY(namespace,tenant))');
  }).catch(error=>{prepared=undefined;throw error;});
  function visible(state:State):ReplicasImportStatus{const {id,organization,phase,total,processed,imported,events,turns,pages,updatedAt,sample}=state;return {id,organization,phase,total,processed,imported,events,turns,pages,updatedAt,sample};}
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
        if(identity.caller!=='organization_api_key')throw replicasError('The organization history export requires an organization API key.');
        const page=await api.conversations();
        state={id:randomUUID(),organization:identity.organization,phase:'preview',total:page.total,processed:0,imported:0,events:0,turns:0,pages:0,updatedAt:new Date().toISOString(),sample:page.conversations.slice(0,5).map(chat=>({title:chat.title??'Untitled chat',workspace:chat.workspace_name,provider:chat.provider})),queue:page.conversations,next:page.next_cursor,before:null,listCursors:[],historyCursors:[],occurrences:{},completedSessions:[]};
        credential=envelope.seal(path,Buffer.from(apiKey));
      }else{
        if(!state||state.id!==input.id)throw replicasError('This import changed. Reload Integrations before continuing.',409);
        if(input.action==='disconnect'){credential=null;state.phase='disconnected';state.queue=[];state.next=null;state.before=null;state.occurrences={};}
        if(input.action==='start'){
          if(state.phase!=='preview')throw replicasError('Preview this import before starting.',409);
          state.phase='importing';
        }
        if(input.action==='step'&&state.phase!=='complete'){
          if(state.phase!=='importing'||!credential)throw replicasError('Preview and approve the import before reading history.',409);
          const api=replicasApi(envelope.open(path,credential).toString(),request),chat=state.queue[0];
          if(chat){
            let history;
            try{history=await api.history(chat,state.before);}catch(error){
              if(error instanceof Error&&'status' in error&&[403,404,409].includes(Number(error.status)))throw replicasError('Replicas could not provide this conversation. The import is paused without skipping it. Check organization-key access, Team workspace visibility and retained history, then resume.',409);
              throw error;
            }
            const next=history.before_cursor??null;
            if(next&&(next===state.before||state.historyCursors.includes(replicasDigest(next))))throw replicasError('Replicas repeated a history cursor. The import paused safely.',502);
            if(history.has_more===true&&!next)throw replicasError('Replicas omitted the next history cursor. Resume to retry.',502);
            const events=replicasEvents(chat,history,state.occurrences,state.before);
            const owner={tenantId:principal.tenantId,userId:'workload_replicas_'+replicasDigest('history-v2:'+state.organization.id+':'+chat.workspace_id)};
            const base={schemaVersion:1,installationId:'replicas-history-v2:'+state.organization.id,sessionId:'replicas-chat:'+chat.chat_id,harness:'replicas',origin:'cloud',captureMode:'history',owner,title:'[Replicas history] '+(chat.title??chat.workspace_name),attachments:[]};
            // A full response archive and its searchable records can together
            // exceed one ingest batch. Split without truncating any record.
            let batch:SessionEvent[]=[],bytes=Buffer.byteLength(JSON.stringify(base))+32;
            const flush=async()=>{if(!batch.length)return;const result=await ingest(owner,{...base,events:batch});if(result&&typeof result==='object'&&'discarded' in result)throw replicasError('This session was deleted in OpenCrawl. Its history was not imported.',409);batch=[];bytes=Buffer.byteLength(JSON.stringify(base))+32;};
            for(const event of events){const size=Buffer.byteLength(JSON.stringify(event))+1;if(size>15*1024*1024)throw replicasError('A retained history record exceeds the ingest limit. No history was discarded.',413);if(batch.length&&(batch.length===1000||bytes+size>15*1024*1024))await flush();batch.push(event);bytes+=size;}
            await flush();
            state.events+=history.events.length;state.turns+=replicasTurns(history).length;state.pages++;
            if(next){state.before=next;state.historyCursors.push(replicasDigest(next));}
            else{state.processed++;const session=replicasDigest(chat.workspace_id+':'+chat.chat_id);if(!state.completedSessions.includes(session))state.completedSessions.push(session);state.imported=state.completedSessions.length;state.queue.shift();state.before=null;state.historyCursors=[];state.occurrences={};}
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
    return {provider:'replicas',name:'Replicas',description:'Import complete retained session history directly from your Replicas organization.',auth:'api-key',scope:'team',state:history?'connected':'disconnected',account:history?.organization.name,rows:history?[{label:'Chats imported',count:history.imported,done:history.phase==='complete'},{label:'Events preserved',count:history.events,done:history.phase==='complete'},{label:'History pages',count:history.pages,done:history.phase==='complete'}]:[],history:history??undefined};
  }
  return {status,action,source};
}
