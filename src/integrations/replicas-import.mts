import {randomUUID} from 'node:crypto';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import type {Principal,SessionBatch,SessionEvent} from '../sessions/types.mjs';
import type {SourceCard} from '../application/types.mjs';
import {sealedEnvelope} from './credential-vault.mjs';
import {replicasApi,replicasError,ReplicasProviderError,ReplicasPageError,type ReplicasConversation,type ReplicasHistory,type ReplicasResponseInfo} from './replicas-api.mjs';
import {packReplicasPayload} from '../sessions/replicas-payload.mjs';
import {replicasSenderEvidence,chunkSenderEvidence} from './replicas-senders.mjs';
import {canonical,replicasDigest,replicasEvents,replicasTurns} from './replicas-events.mjs';

import {hasWorkspaceExportReview,reviewWorkspaceExport} from './replicas-export-review.mjs';
import {observeReplicasWorkspace} from './replicas-inventory.mjs';
import {checkpoint,deferredHistory,emptyCheckpoint,type HistoryCheckpoint} from './replicas-deferred.mjs';
import {authDenied,issueFor,retryDelay,type ImportIssue,type ImportOperation} from './replicas-recovery.mjs';

export interface ReplicasImportStatus {
  id:string;organization:{id:string;name:string};phase:'preview'|'importing'|'complete'|'disconnected'|'failed';
  total:number;processed:number;imported:number;events:number;turns:number;pages:number;updatedAt:string;
  error?:string;waitingForSource?:boolean;blocked?:number;blockedChats?:number;retryAt?:string;
}
export type ReplicasImportInput={action:'connect';apiKey:string}|{action:'stop';id:string};
export interface ReplicasJob {tenantId:string;id:string}
interface State extends ReplicasImportStatus,HistoryCheckpoint {
  background?:boolean;queue:ReplicasConversation[];next:string|null;listCursors:string[];completedSessions:string[];
  workspaceChecks?:{id:string;at:number}[];
  initialCatalog?:boolean;freshSteps?:number;continuationSteps?:number;exportReviewSteps?:number;retryAttempts?:number;recentIssues?:ImportIssue[];
}
// Reserve one activity in five for due pages while catalog work remains.
const freshStepsPerRetry=4;
export type ReplicasImport=ReturnType<typeof createReplicasImport>;

/** One explicit step reads one complete API page. Checkpoint only after the
 * original response and every projected record reach durable ingest/indexing.
 * Missing access and unknown pagination fail closed; no conversation is skipped. */
export function createReplicasImport({database,key,ingest,schedule,request=fetch,now=Date.now}:{database:ApplicationDatabase;key:Uint8Array;ingest:(principal:Principal,batch:SessionBatch,gate?:undefined,blobs?:ReadonlyMap<string,Uint8Array>)=>Promise<unknown>;schedule:(job:ReplicasJob)=>Promise<unknown>;request?:typeof fetch;now?:()=>number}){
  const envelope=sealedEnvelope(key),namespace=database.namespace;
  let prepared:Promise<void>|undefined;
  const ready=()=>prepared??=database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:replicas-import:schema',0))");
    await client.query('CREATE TABLE IF NOT EXISTS opencrawl_replicas_imports(namespace text NOT NULL,tenant text NOT NULL,state jsonb NOT NULL,credential bytea,PRIMARY KEY(namespace,tenant))');
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_replicas_deferred(
      namespace text NOT NULL, tenant text NOT NULL, id bigint GENERATED ALWAYS AS IDENTITY,
      retry_at timestamptz NOT NULL, chat jsonb NOT NULL, checkpoint jsonb NOT NULL, issue jsonb NOT NULL,
      PRIMARY KEY(namespace,tenant,retry_at,id))`);
    await client.query(`CREATE INDEX IF NOT EXISTS opencrawl_replicas_deferred_continuation
      ON opencrawl_replicas_deferred(namespace,tenant,retry_at,id) WHERE issue ? 'continuation' AND checkpoint->>'before' IS NOT NULL`);
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_replicas_workspace_inventories(
      namespace text NOT NULL,tenant text NOT NULL,import_id text NOT NULL,workspace text NOT NULL,checked_at timestamptz NOT NULL,
      chat_ids text[],result text NOT NULL,PRIMARY KEY(namespace,tenant,import_id,workspace))`);
    await client.query('ALTER TABLE opencrawl_replicas_workspace_inventories ADD COLUMN IF NOT EXISTS export_check jsonb');
    await client.query(`CREATE INDEX IF NOT EXISTS opencrawl_replicas_deferred_chat
      ON opencrawl_replicas_deferred(namespace,tenant,(chat->>'workspace_id'),(chat->>'chat_id'))`);
  }).catch(error=>{prepared=undefined;throw error;});
  function visible(state:State):ReplicasImportStatus{
    const {id,organization,phase,total,processed,imported,events,turns,pages,updatedAt,blocked,retryAt,waitingForSource}=state;
    const error=state.error?.startsWith('Replicas could not read all retained history. Check the organization key')?
      'The previous import stopped before recording the provider status. Reconnect to resume from the saved page.':state.error;
    return {id,organization,phase:phase==='importing'&&!state.background?'preview':phase,total,processed,imported,events,turns,pages,updatedAt,error,blocked,retryAt,waitingForSource};
  }
  async function status(principal:Principal,includeBlockedChats=true){
    await ready();
    const row=(await database.pool.query(`SELECT jsonb_strip_nulls(to_jsonb(summary)) AS state,
      CASE WHEN $3 AND summary.blocked>0 THEN
        (SELECT count(DISTINCT (chat->>'workspace_id',chat->>'chat_id'))::int
           FROM opencrawl_replicas_deferred WHERE namespace=$1 AND tenant=$2) END AS blocked_chats
      FROM opencrawl_replicas_imports AS i
      CROSS JOIN LATERAL jsonb_to_record(i.state) AS summary(id text,organization jsonb,phase text,background boolean,
        total bigint,processed bigint,imported bigint,events bigint,turns bigint,pages bigint,"updatedAt" text,
        error text,blocked bigint,"retryAt" text,"waitingForSource" boolean)
      WHERE i.namespace=$1 AND i.tenant=$2`,[namespace,principal.tenantId,includeBlockedChats])).rows[0];
    return row?{...visible(row.state as State),blockedChats:row.blocked_chats??undefined}:null;
  }
  async function savePage(principal:Principal,state:State,chat:ReplicasConversation,history:ReplicasHistory){
    const next=history.before_cursor??null;
    if(next&&(next===state.before||state.historyCursors.includes(replicasDigest(next))))throw new ReplicasPageError('cursor','Replicas repeated a history cursor.');
    if(history.has_more===true&&!next)throw new ReplicasPageError('cursor','Replicas omitted a history cursor.');
    const occurrences={...state.occurrences};
    const evidence=replicasSenderEvidence(chat,history);
    const events=replicasEvents(chat,history,occurrences,state.before);
    const owner={tenantId:principal.tenantId,userId:'workload_replicas_'+replicasDigest('history-v2:'+state.organization.id+':'+chat.workspace_id)};
    const base={schemaVersion:1,installationId:'replicas-history-v2:'+state.organization.id,sessionId:'replicas-chat:'+chat.chat_id,harness:'replicas',origin:'cloud',captureMode:'history',owner,title:'[Replicas history] '+(chat.title??chat.workspace_name),attachments:[]};
    // A full response archive and its searchable records can together
    // exceed one ingest batch. Split without truncating any record.
    const baseBytes=Buffer.byteLength(JSON.stringify(base))+32,limit=15*1024*1024;
    let batch:SessionEvent[]=[],bytes=baseBytes;
    const put=async(events:SessionEvent[],evidenceEvents:SessionEvent[],attachments:SessionBatch['attachments']=[],blobs?:ReadonlyMap<string,Uint8Array>)=>{
      const result=await ingest(owner,{...base,...chunkSenderEvidence(evidenceEvents,evidence.replicasSenders),attachments,events},undefined,blobs);
      if(result&&typeof result==='object'&&'discarded' in result)throw new ReplicasPageError('deleted','The session was deleted in OpenCrawl.');
    };
    const flush=async()=>{if(batch.length)await put(batch,batch);batch=[];bytes=baseBytes;};
    for(const event of events){
      const size=Buffer.byteLength(JSON.stringify(event))+1;
      if(bytes+size>limit||batch.length===1000)await flush();
      if(baseBytes+size>limit){
        const packed=packReplicasPayload(event,canonical(event.data));
        await put([packed.event],[event],packed.attachments,packed.blobs);
        console.info(JSON.stringify({event:'replicas.import.large_record',tenantId:principal.tenantId,importId:state.id,
          workspaceId:chat.workspace_id,chatId:chat.chat_id,bytes:size,parts:packed.attachments.length}));
      }else{batch.push(event);bytes+=size;}
    }
    await flush();
    state.events+=history.events.length;state.turns+=replicasTurns(history).length;state.pages++;
    state.occurrences=occurrences;state.chatAttempts=0;
    if(next){state.before=next;state.historyCursors.push(replicasDigest(next));return;}
    state.processed++;
    const session=replicasDigest(chat.workspace_id+':'+chat.chat_id);
    if(!state.completedSessions.includes(session))state.completedSessions.push(session);
    state.imported=state.completedSessions.length;
    state.queue.shift();Object.assign(state,emptyCheckpoint());
  }

  async function step(client:Pick<ApplicationDatabase['pool'],'query'>,principal:Principal,state:State,api:ReturnType<typeof replicasApi>){
    if(state.retryAt&&Date.parse(state.retryAt)>now())return;
    delete state.retryAt;
    const pending=deferredHistory(client,namespace,principal.tenantId);
    const hasFresh=Boolean(state.queue.length||state.next||state.initialCatalog);
    const reviewScope:[string,string,string]=[namespace,principal.tenantId,state.id];
    const review=async()=>{
      const result=await reviewWorkspaceExport(client,reviewScope,state.completedSessions,api,now());
      if(result.added){state.total+=result.added;state.blocked=(state.blocked??0)+result.added;delete state.waitingForSource;}
      return result.requested;
    };
    if(!hasFresh){
      state.exportReviewSteps=(state.exportReviewSteps??0)+1;
      if(!state.blocked||state.exportReviewSteps>=5){state.exportReviewSteps=0;if(await review())return;}
    }
    if(state.blocked&&(!hasFresh||(state.freshSteps??freshStepsPerRetry)>=freshStepsPerRetry)){
      state.freshSteps=0;
      // Once the catalog is drained, let a readable long transcript advance
      // while still servicing the oldest unrelated retry at least every fifth step.
      const preferContinuation=!hasFresh&&(state.continuationSteps??0)<freshStepsPerRetry;
      const row=await pending.oldest(preferContinuation,now());
      if(!row)throw new Error('Replicas deferred checkpoint missing');
      if(row.retry_at.getTime()<=now()){
        state.continuationSteps=preferContinuation&&row.issue.continuation&&row.checkpoint.before?(state.continuationSteps??0)+1:0;
        // Run a single deferred page, independently of a possibly mid-chat foreground cursor.
        const foreground={...checkpoint(state),queue:state.queue,next:state.next,initialCatalog:state.initialCatalog};
        await pending.remove(row);state.blocked--;
        Object.assign(state,row.checkpoint,{queue:[row.chat],next:null,initialCatalog:false});
        await processPage(principal,state,api,pending,true,client);
        if(state.queue.length){
          const resumed=state.before&&state.before!==row.checkpoint.before;
          const issue:ImportIssue=resumed?{at:new Date(now()).toISOString(),importId:state.id,operation:'history',reason:'page_saved',
            decision:'continue',attempt:0,elapsedMs:0,workspaceId:row.chat.workspace_id,chatId:row.chat.chat_id,
            pageLimit:state.pageLimit,cursorHash:replicasDigest(state.before!)}:(state.recentIssues?.at(-1)??row.issue);
          await pending.save(row.chat,state,{...issue,continuation:true},state.retryAt??new Date(now()).toISOString());
          state.blocked++;
        }
        Object.assign(state,foreground);
        return;
      }
      if(!hasFresh){
        if(await hasWorkspaceExportReview(client,reviewScope)){
          if(await review()||await hasWorkspaceExportReview(client,reviewScope))return;
        }
        state.retryAt=row.retry_at.toISOString();
        state.waitingForSource=await pending.onlyAbsent();
        return;
      }
    }
    state.freshSteps=Math.min(freshStepsPerRetry,(state.freshSteps??0)+1);
    await processPage(principal,state,api,pending,false,client);
  }

  async function processPage(principal:Principal,state:State,api:ReturnType<typeof replicasApi>,pending:ReturnType<typeof deferredHistory>,retry:boolean,client:Pick<ApplicationDatabase['pool'],'query'>){
    const chat=state.queue[0];
    const started=now(),recoveredAttempt=state.chatAttempts;
    let previousMissingAttempt=0;
    let historyResponse:ReplicasResponseInfo|undefined;
    let observedInventory:Awaited<ReturnType<typeof api.workspaceChats>>|undefined;
    let recoveredPage:{events:number;turns:number;final:boolean}|undefined;
    let operation:ImportOperation=chat?'history':'catalog';
    try{
      if(chat){
        if(!retry&&state.blocked){
          const shared=await pending.backoff(chat,state,state.id);
          previousMissingAttempt=shared?.issue.attempt??0;
          if(shared&&shared.retry_at.getTime()>now()){
            await pending.save(chat,{...checkpoint(state),chatAttempts:shared.issue.attempt},shared.issue,shared.retry_at.toISOString());
            state.blocked++;state.queue.shift();Object.assign(state,emptyCheckpoint());state.retryAttempts=0;delete state.error;
            return;
          }
        }
        const history=await api.history(chat,state.before,state.pageLimit??100,info=>{historyResponse=info;});
        if(!state.before&&!history.before_cursor&&history.has_more!==true&&!history.events.length&&!replicasTurns(history).length){
          const senderLists=[chat.senders,history.senders];
          const removed=new Set(Array.isArray(history.removed_message_ids)?history.removed_message_ids:[]);
          const knownMessages=senderLists.some(list=>Array.isArray(list)&&list.some(row=>{
            if(!row||typeof row!=='object')return false;
            if(typeof row.message_id==='string'&&row.message_id)return !removed.has(row.message_id);
            return typeof row.sender_user_id==='string'&&typeof row.recorded_at==='string';
          }));
          if(knownMessages||typeof history.total==='number'&&history.total>0){
            throw new ReplicasPageError('empty_with_messages','Replicas returned an empty transcript for a chat with recorded messages.');
          }
          if(typeof history.thread_id!=='string'||!history.thread_id){
            let confirmed=false;
            try{
              const inventory=await api.workspaceChats(chat.workspace_id);
              observedInventory=inventory;
              confirmed=!inventory.waking&&inventory.chats.some(item=>item.id===chat.chat_id);
            }catch(check){
              // A catalog outage/rate limit is retried through its normal provider policy.
              if(!(check instanceof ReplicasProviderError)||check.status!==404)throw check;
            }
            if(!confirmed)throw new ReplicasPageError('empty_unverified','Replicas could not confirm this empty chat in its workspace.');
          }
        }
        if(retry&&state.blocked)await pending.releaseBackoff(chat,state,new Date(now()).toISOString(),Boolean(history.events.length||replicasTurns(history).length));
        delete state.waitingForSource;
        operation='ingest';
        await savePage(principal,state,chat,history);
        const limit=state.pageLimit??100;
        if(history.before_cursor&&limit<100&&historyResponse?.bytesRead!==undefined&&historyResponse.bytesRead<3*1024*1024){
          // A large event affects its own page. Grow after a small successful
          // page so thousands of subsequent events do not take one request each.
          state.pageLimit=Math.min(100,limit*4);
          console.info(JSON.stringify({event:'replicas.import.page_limit',tenantId:principal.tenantId,importId:state.id,
            workspaceId:chat.workspace_id,chatId:chat.chat_id,previous:limit,next:state.pageLimit,bytesRead:historyResponse.bytesRead}));
        }
        if(recoveredAttempt||state.retryAttempts)recoveredPage={events:history.events.length,turns:replicasTurns(history).length,final:!history.before_cursor};
      }else if(state.initialCatalog||state.next){
        const hash=state.next?replicasDigest(state.next):undefined;
        if(hash&&state.listCursors.includes(hash))throw new ReplicasPageError('cursor','Replicas repeated a catalog cursor.');
        const page=await api.conversations(state.next);
        if(state.initialCatalog)state.total=page.total;
        delete state.initialCatalog;
        state.queue=page.conversations;state.next=page.next_cursor;
        if(hash)state.listCursors.push(hash);
      }
      if(state.retryAttempts||recoveredAttempt){
        console.info(JSON.stringify({event:'replicas.import.recovered',tenantId:principal.tenantId,importId:state.id,
          workspaceId:chat?.workspace_id,chatId:chat?.chat_id,operation,elapsedMs:now()-started,...recoveredPage}));
      }
      state.retryAttempts=0;delete state.error;
      return;
    }catch(cause){
      let error=cause, credentialRejected=false;
      let identityCheck:ImportIssue['identityCheck'];
      if(authDenied(error)){
        try{
          const identity=await api.identity();
          credentialRejected=identity.caller!=='organization_api_key'||identity.organization.id!==state.organization.id;
          identityCheck=credentialRejected?'identity_mismatch':'verified';
        }catch(check){
          credentialRejected=check instanceof ReplicasProviderError&&check.status===401;
          identityCheck=credentialRejected?'rejected':'unavailable';
          // Verification itself may be unavailable. Retain the key and retry the same page.
          error=check;operation='identity';
        }
      }
      const fields=issueFor(error,operation);
      if(error instanceof ReplicasPageError&&operation==='history'&&historyResponse)Object.assign(fields,historyResponse);
      const tooLarge=fields.operation!=='identity'&&(error instanceof ReplicasPageError&&error.reason==='page_size'||(fields.httpStatus===413||fields.internalStatus===413));
      const limit=state.pageLimit??100;
      const localToChat=!!chat&&fields.operation!=='identity'&&(error instanceof ReplicasPageError||tooLarge||fields.reason==='record_rejected'||
        (fields.operation==='history'||fields.operation==='workspace_chats')&&error instanceof ReplicasProviderError&&![408,425,429].includes(error.status));
      const decision=credentialRejected?'reconnect':chat&&tooLarge&&limit>1?'resize':localToChat?'defer':'retry';
      const missing=fields.operation==='history'&&fields.httpStatus===404;
      const priorChatAttempts=Math.max(state.chatAttempts??0,missing?previousMissingAttempt:0);
      const attempt=(decision==='defer'?priorChatAttempts:state.retryAttempts??0)+1;
      const wait=retryDelay(attempt,decision==='defer'?60_000:2_000,error instanceof ReplicasProviderError?error.retryAfterMs:0);
      let retryAt=new Date(now()+wait).toISOString();
      const issue:ImportIssue={...fields,importId:state.id,decision,attempt,identityCheck,elapsedMs:Math.max(0,now()-started),
        ...(error!==cause&&cause instanceof ReplicasProviderError?{originalHttpStatus:cause.status,originalOperation:cause.operation,originalRequestId:cause.requestId}:{}),at:new Date(now()).toISOString(),
        ...(decision==='defer'||decision==='retry'?{retryAt}:{}),
        ...(chat?{workspaceId:chat.workspace_id,chatId:chat.chat_id,pageLimit:limit}:{}),
        ...(state.before||(!chat&&state.next)?{cursorHash:replicasDigest((chat?state.before:state.next)!)}:{})};
      const empty=fields.reason==='empty_with_messages'||fields.reason==='empty_unverified';
      if(chat&&retry&&!state.before&&(empty||missing)){
        const observation=await observeReplicasWorkspace(client,{namespace,tenant:principal.tenantId,importId:state.id,workspace:chat.workspace_id},
          now(),()=>observedInventory?Promise.resolve(observedInventory):api.workspaceChats(chat.workspace_id));
        const ids=observation.ids;
        if(ids){
          const listed=ids.has(chat.chat_id);
          if(!listed){
            issue.workspaceAbsentAt=new Date(observation.checkAt).toISOString();
            // Keep one real history probe per workspace at the next inventory refresh.
            retryAt=new Date(observation.fresh?observation.next:Math.max(Date.parse(retryAt),observation.next)).toISOString();
            issue.retryAt=retryAt;
          }
          if(observation.fresh){
            const saved=new Set(state.completedSessions);
            issue.workspaceInventory={result:listed?'listed':'absent',chats:ids.size,
              savedChats:[...ids].filter(id=>saved.has(replicasDigest(chat.workspace_id+':'+id))).length};
            console.info(JSON.stringify({event:'replicas.import.workspace_inventory',tenantId:principal.tenantId,importId:state.id,workspaceId:chat.workspace_id,
              retainedChats:ids.size,savedChats:issue.workspaceInventory.savedChats,postponed:observation.moved,released:observation.released}));
            const recent=(state.workspaceChecks??[]).filter(check=>check.at>now()-30*60_000);
            if(!listed&&recent.length<32&&!recent.some(check=>check.id===chat.workspace_id)){
              state.workspaceChecks=[...recent,{id:chat.workspace_id,at:now()}];
              try{
                const page=await api.conversations(null,chat.workspace_id);
                issue.workspaceExport=page.conversations.every(item=>item.workspace_id===chat.workspace_id)
                  ?{result:'scoped',total:page.total,hasMore:Boolean(page.next_cursor),onFirstPage:page.conversations.some(item=>item.chat_id===chat.chat_id)}
                  :{result:'scope_mismatch'};
              }catch{issue.workspaceExport={result:'unavailable'};}
            }
          }
        }else if(observation.fresh)issue.workspaceInventory=observation.result==='waking'?{result:'waking',chats:0}:{result:'unavailable',httpStatus:observation.httpStatus};
      }
      if(!issue.workspaceAbsentAt)delete state.waitingForSource;
      state.recentIssues=[...(state.recentIssues??[]).slice(-31),issue];
      console.warn(JSON.stringify({event:'replicas.import.issue',tenantId:principal.tenantId,importId:state.id,
        organizationId:state.organization.id,processed:state.processed,pages:state.pages,...issue}));
      if(decision==='reconnect'){
        state.phase='failed';state.error='Replicas rejected the organization credential. Reconnect with a valid key for the same organization.';
      }else if(decision==='resize'){
        state.pageLimit=Math.max(1,Math.floor(limit/2));
      }else if(decision==='defer'&&chat){
        const position={...checkpoint(state),chatAttempts:attempt};
        if(missing&&state.blocked){
          const shared=await pending.shareFailure(chat,position,issue,retryAt);
          if(shared)console.info(JSON.stringify({event:'replicas.import.shared_backoff',tenantId:principal.tenantId,
            importId:state.id,workspaceId:chat.workspace_id,chatId:chat.chat_id,additionalRecords:shared,attempt,retryAt}));
        }
        if(retry&&state.blocked&&(fields.reason==='empty_with_messages'||fields.reason==='empty_unverified')){
          const shared=await pending.shareEmptyPage(chat,position,issue,retryAt);
          if(shared)console.info(JSON.stringify({event:'replicas.import.shared_backoff',tenantId:principal.tenantId,
            importId:state.id,workspaceId:chat.workspace_id,chatId:chat.chat_id,reason:fields.reason,additionalRecords:shared,attempt,retryAt}));
        }
        await pending.save(chat,position,issue,retryAt);
        state.blocked=(state.blocked??0)+1;state.queue.shift();Object.assign(state,emptyCheckpoint());
        state.retryAttempts=0;delete state.error;
        if(error instanceof ReplicasProviderError&&error.status>=500){
          state.retryAt=new Date(now()+Math.max(2_000,error.retryAfterMs??0)).toISOString();
        }
      }else{
        state.retryAttempts=attempt;state.retryAt=retryAt;
        state.error=`The ${fields.operation} step will retry automatically${fields.httpStatus?' (HTTP '+fields.httpStatus+')':''}.`;
      }
    }
  }
  async function operate(principal:Principal,input:ReplicasImportInput|{action:'step';id:string}):Promise<ReplicasImportStatus|null>{
    await ready();
    return database.transaction(async client=>{
      const path=JSON.stringify([namespace,principal.tenantId]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['replicas-import:'+path]);
      const row=(await client.query('SELECT state,credential FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[namespace,principal.tenantId])).rows[0];
      let state:State|undefined=row?.state,credential:Buffer|null=row?.credential??null;
      if(input.action==='connect'){
        const apiKey=input.apiKey.trim();
        if(!apiKey||apiKey.length>4000||/[\r\n]/.test(apiKey))throw replicasError('Enter a Replicas organization API key.');
        const api=replicasApi(apiKey,request),identity=await api.identity();
        if(identity.caller!=='organization_api_key')throw replicasError('Create an organization API key in Replicas Settings → API Keys.');
        if(state?.background&&state.phase==='importing'){
          if(state.organization.id!==identity.organization.id)throw replicasError('This workspace already has a Replicas import in progress.',409);
          return visible(state);
        }
        const resume=state&&['failed','importing','disconnected'].includes(state.phase)?state:undefined;
        if(resume&&resume.organization.id!==identity.organization.id)throw replicasError('Use the Replicas organization that owns the saved import.',409);
        state=resume??{id:'',organization:identity.organization,phase:'importing',total:0,processed:0,imported:0,events:0,turns:0,pages:0,
          updatedAt:'',queue:[],initialCatalog:true,next:null,listCursors:[],completedSessions:[],...emptyCheckpoint()};
        await client.query('DELETE FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2',[namespace,principal.tenantId]);
        delete state.waitingForSource;
        state.id=randomUUID();state.background=true;state.retryAttempts=0;delete state.error;delete state.retryAt;
        state.phase=state.queue.length||state.initialCatalog||state.next||state.blocked?'importing':'complete';
        if(!resume)await step(client,principal,state,api);
        credential=envelope.seal(path,Buffer.from(apiKey));
      }else{
        if(!state||state.id!==input.id||state.phase!=='importing')return null;
        if(input.action==='stop'){
          state.phase='disconnected';delete state.retryAt;delete state.error;
        }else if(!credential){
          state.phase='failed';state.error='Reconnect with the organization key to resume the saved import.';
        }else{
          await step(client,principal,state,replicasApi(envelope.open(path,credential).toString(),request));
        }
      }
      if(state.phase==='importing'&&!state.queue.length&&!state.next&&!state.initialCatalog&&!state.blocked&&
        !await hasWorkspaceExportReview(client,[namespace,principal.tenantId,state.id]))state.phase='complete';
      if(state.phase!=='importing')credential=null;
      state.updatedAt=new Date(now()).toISOString();
      await client.query('INSERT INTO opencrawl_replicas_imports(namespace,tenant,state,credential) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(namespace,tenant) DO UPDATE SET state=EXCLUDED.state,credential=EXCLUDED.credential',[namespace,principal.tenantId,JSON.stringify(state),credential]);
      // Hold the tenant lock through acceptance. The first worker waits for commit.
      if(input.action==='connect'&&state.phase==='importing')await schedule({tenantId:principal.tenantId,id:state.id});
      if(input.action!=='step'||state.phase!=='importing'){
        console.info(JSON.stringify({event:'replicas.import.transition',tenantId:principal.tenantId,importId:state.id,
          action:input.action,phase:state.phase,processed:state.processed,total:state.total,blocked:state.blocked??0,pages:state.pages}));
      }
      return visible(state);
    });
  }
  async function source(principal:Principal):Promise<SourceCard>{
    const history=await status(principal,false);
    const phase=history?.phase;
    const state=phase==='complete'?'synced':phase==='importing'?'syncing':phase==='failed'?'error':'disconnected';
    return {provider:'replicas',name:'Replicas',description:'Import session history from your Replicas organization.',auth:'api-key',scope:'team',state,
      account:history?.organization.name,synced:history?.imported,units:['session','sessions'],
      message:phase==='failed'?history?.error:undefined,
      lastSyncedAt:phase==='complete'?history?.updatedAt:undefined,
      rows:history&&state!=='disconnected'?[{label:'Sessions',count:history.imported,done:phase==='complete'}]:[],history:history??undefined};
  }
  return {status,source,
    async action(principal:Principal,input:ReplicasImportInput){
      let result;
      try{result=await operate(principal,input);}
      catch(error){
        if(input.action==='connect'&&error instanceof ReplicasProviderError){
          console.warn(JSON.stringify({event:'replicas.import.connect_failed',tenantId:principal.tenantId,...issueFor(error,error.operation)}));
        }
        throw error;
      }
      if(input.action==='connect'&&result?.phase==='failed')throw replicasError(result.error??'Replicas rejected this credential.');
      if(!result)throw replicasError('This import has already stopped or changed.',409);
      return result;
    },
    async advance(job:ReplicasJob){return (await operate({tenantId:job.tenantId,userId:'replicas-import'},{action:'step',id:job.id}))?.phase!=='importing';},
    async runStep(job:ReplicasJob){
      const result=await operate({tenantId:job.tenantId,userId:'replicas-import'},{action:'step',id:job.id});
      return {done:result?.phase!=='importing',...(result?.phase==='failed'?{requiresReconnect:true}:{}),delayMs:result?.retryAt?Math.max(0,Date.parse(result.retryAt)-now()):0};
    },
  };
}
