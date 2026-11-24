import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {ApplicationDatabase,ApplicationTransaction} from '../state/postgres.mjs';
import {writeReplicasEvents,type ReplicasIngest} from './replicas-batch.mjs';
import {record} from '../sessions/replicas-record.mjs';
import {replicasRecords,replicasSession} from './replicas-events.mjs';
import {replicasThread,saveReplicasThread} from './replicas-threads.mjs';
import {replicasSenderEvidence} from './replicas-senders.mjs';
import {replicasLiveApi} from './replicas-live-api.mjs';
import {ReplicasPageError,ReplicasProviderError} from './replicas-api.mjs';
import type {ReplicasHistory,ReplicasConversation} from './replicas-api.mjs';
import {sealedEnvelope} from './credential-vault.mjs';

export interface ReplicasLiveScope {tenantId:string;organizationId:string}
export interface ReplicasRepairJob extends ReplicasLiveScope {kind:'live-repair';id:string}
interface GapPosition {
  generation:string; catalog:string|null; catalogCursors:string[]; chats:ReplicasConversation[];
  before:string|null; historyCursors:string[]; occurrences:Record<string,number>;
}
type Connection={id:string;credential:Buffer};
type Api=ReturnType<typeof replicasLiveApi>;
const uuid=z.string().uuid();
const pause=(ms:number,signal:AbortSignal)=>delay(ms,undefined,{signal}).catch(()=>{});
const retry=(error:unknown,attempt:number)=>Math.max(error instanceof ReplicasProviderError?error.retryAfterMs??0:0,Math.min(30000,300*2**Math.min(attempt,7)));
const liveState='opencrawl_replicas_live_workspaces';
const tails='opencrawl_replicas_live_tails';

function diagnostic(scope:ReplicasLiveScope,operation:string,error:unknown){
  console.warn(JSON.stringify({event:'replicas.live.retry',tenantId:scope.tenantId,operation,
    ...(error instanceof ReplicasProviderError?{httpStatus:error.status}:{})}));
}

export function createReplicasLiveCapture({database,ready,key,ingest,schedule,request=fetch}:{
  database:ApplicationDatabase;ready:()=>Promise<void>;key:Uint8Array;ingest:ReplicasIngest;schedule:(job:ReplicasRepairJob)=>Promise<unknown>;request?:typeof fetch;
}){
  const envelope=sealedEnvelope(key),namespace=database.namespace;
  // Only worker-configured scopes may resolve a repair job to a provider credential.
  const repairs=new Map<string,(job:ReplicasRepairJob,signal:AbortSignal)=>Promise<number|null>>();
  const scopeKey=(scope:ReplicasLiveScope)=>JSON.stringify([scope.tenantId,scope.organizationId]);
  async function run(scope:ReplicasLiveScope,stop:AbortSignal){
    if(!scope.tenantId?.trim()||!uuid.safeParse(scope.organizationId).success)throw new Error('Explicit Replicas live capture scope required');
    const binding=[namespace,scope.tenantId,scope.organizationId];
    const connectionSql=`SELECT state->>'id' AS id,credential FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2
      AND state->'organization'->>'id'=$3 AND state->>'phase' IN ('importing','complete') AND credential IS NOT NULL`;
    const identityPath=JSON.stringify([namespace,scope.tenantId]);
    async function hold(active:Connection,action:(tx:ApplicationTransaction)=>Promise<void>){
      await database.transaction(async tx=>{
        const allowed=await tx.query(connectionSql+" AND state->>'id'=$4 AND credential=$5 FOR SHARE",[...binding,active.id,active.credential]);
        if(!allowed.rowCount)throw new Error('Replicas live capture authorization changed');
        await action(tx);
      });
    }
    async function capture(tx:ApplicationTransaction,workspace:string,chat:string,history:ReplicasHistory,mode:'history'|'live',title?:string,occurrences:Record<string,number>={},catalog:Record<string,unknown>={}){
      const identity=replicasSession(scope.tenantId,scope.organizationId,workspace,chat);
      const events=replicasRecords(chat,history,occurrences);
      if(events.length){
        const evidence=replicasSenderEvidence({...catalog,workspace_id:workspace},history);
        // History and live frames have the same provider records and immutable IDs.
        // A replay may write another batch, but the transcript and search key each event once.
        try{await writeReplicasEvents(ingest,{...identity,title,attachments:[],captureMode:mode},events,evidence.replicasSenders);}
        catch(error){if(!(error instanceof ReplicasPageError&&error.reason==='deleted'))throw error;}
      }
      // The binding and cursor become visible together at commit. Take the
      // thread row lock only after storage and durable index dispatch finish:
      // a long history page must not block a live write for the same chat.
      const thread=replicasThread(history);
      if(thread)await saveReplicasThread(tx,namespace,scope.tenantId,identity.owner.userId,identity.sessionId,thread);
    }
    async function collectWorkspace(active:Connection,api:Api,workspace:string,signal:AbortSignal){
      const stateKey=[...binding,workspace];
      let attempt=0,lastHeartbeat=0;
      while(!signal.aborted){
        try{
          const row=await database.pool.query<{cursor:string|null}>(`SELECT cursor FROM ${liveState} WHERE namespace=$1 AND tenant=$2 AND organization=$3 AND workspace=$4`,stateKey);
          await api.stream(workspace,row.rows[0]?.cursor??null,signal,async frames=>{
            // An opening event advertises the stream head; on a resume it precedes replay.
            const gap=frames.some(f=>f.type==='engine.stream.opened'&&f.payload.resumed!==true);
            const last=frames.findLast(f=>f.type!=='engine.stream.opened');
            if(!last&&!gap)return;
            if(!gap&&frames.every(f=>!f.type.startsWith('chat.'))&&Date.now()-lastHeartbeat<10000)return;
            let needsRepair=gap;
            await hold(active,async tx=>{
              const chats=new Map<string,{events:unknown[];senders:unknown[]}>();
              const refresh=new Set<string>(),opened=new Set<string>();
              for(const frame of frames){
                const id=frame.payload.chatId;
                if(uuid.safeParse(id).success&&(frame.type==='chat.turn.completed'||frame.type==='chat.turn.started'&&!record(frame.payload.event)))refresh.add(String(id));
                if(frame.type!=='chat.turn.started'&&frame.type!=='chat.turn.delta')continue;
                const {chatId,event,sender}=frame.payload;
                const chat=uuid.safeParse(chatId);
                if(!chat.success)throw new Error('Invalid Replicas chat identity');
                if(frame.type==='chat.turn.started')opened.add(chat.data);
                if(!record(event))continue;
                const batch=chats.get(chat.data)??{events:[],senders:[]};
                batch.events.push(event);if(sender)batch.senders.push(sender);
                chats.set(chat.data,batch);
              }
              // Codex stream records omit the native thread ID. Resolve it on the
              // first opening, before this turn's content becomes searchable.
              for(const chat of opened){
                if(replicasThread(chats.get(chat)??{events:[]}))continue;
                const identity=replicasSession(scope.tenantId,scope.organizationId,workspace,chat);
                const known=await tx.query('SELECT 1 FROM opencrawl_replicas_threads WHERE namespace=$1 AND tenant=$2 AND owner_id=$3 AND session_id=$4',
                  [namespace,scope.tenantId,identity.owner.userId,identity.sessionId]);
                if(known.rowCount)continue;
                let thread;
                try{thread=replicasThread(await api.openingHistory({workspace_id:workspace,chat_id:chat}));}
                catch(error){diagnostic(scope,'opening_thread',error);}
                if(thread)await saveReplicasThread(tx,namespace,scope.tenantId,identity.owner.userId,identity.sessionId,thread);
                else refresh.add(chat);
              }
              for(const [chat,batch] of chats)await capture(tx,workspace,chat,batch,'live');
              needsRepair ||= refresh.size>0;
              for(const id of refresh)await tx.query(`INSERT INTO ${tails}(namespace,tenant,organization,workspace,chat)
                VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,tenant,organization,workspace,chat)
                DO UPDATE SET generation=${tails}.generation+1, due=LEAST(${tails}.due,now())`,[...stateKey,id]);
              await tx.query(`INSERT INTO ${liveState}(namespace,tenant,organization,workspace,cursor,observed_at,gap_since,gap_generation)
                VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now()-interval '5 minutes' END,CASE WHEN $7 THEN 1 ELSE 0 END)
                ON CONFLICT(namespace,tenant,organization,workspace) DO UPDATE SET
                cursor=COALESCE(EXCLUDED.cursor,${liveState}.cursor),observed_at=COALESCE(EXCLUDED.observed_at,${liveState}.observed_at),
                gap_generation=${liveState}.gap_generation+EXCLUDED.gap_generation,gap_since=COALESCE(${liveState}.gap_since,CASE WHEN $7 THEN COALESCE(${liveState}.observed_at,now()-interval '5 minutes') END)`,
                [...stateKey,last?.cursor??null,last?.ts??null,gap]);
            });
            // The committed row survives a missed wake. A slow Temporal frontend must
            // not stall delivery of the next socket frame.
            if(needsRepair)notifyRepair(active);
            attempt=0;lastHeartbeat=Date.now();
          });
        }catch(error){
          if(signal.aborted)return;
          diagnostic(scope,'stream',error);
          await pause(retry(error,attempt++),signal);continue;
        }
        await pause(300,signal);
      }
    }

    let waking:Promise<void>|undefined,pendingWake:Connection|undefined;
    function dispatchRepair(){
      if(!pendingWake||waking||stop.aborted)return;
      waking=(async()=>{
        while(pendingWake&&!stop.aborted){
          const active=pendingWake;
          pendingWake=undefined;
          try{await schedule({...scope,kind:'live-repair',id:active.id});}
          catch(error){
            pendingWake??=active;
            diagnostic(scope,'repair_dispatch',error);
            return;
          }
        }
      })().finally(()=>{waking=undefined;});
    }
    function notifyRepair(active:Connection){pendingWake=active;dispatchRepair();}

    // One Activity advances at most one tail and one catalog/history page. All
    // provider data, continuation tokens and occurrence counts stay in Postgres.
    async function repair(job:ReplicasRepairJob,signal:AbortSignal):Promise<number|null>{
      stop.throwIfAborted();
      signal=AbortSignal.any([stop,signal]);
      const active=(await database.pool.query<Connection>(connectionSql+" AND state->>'id'=$4",[...binding,job.id])).rows[0];
      if(!active)return null;
      const tail=(await database.pool.query<{workspace:string;chat:string;generation:string;tail_id:string}>(`SELECT workspace,chat,generation,tail_id FROM ${tails}
        WHERE namespace=$1 AND tenant=$2 AND organization=$3 AND due<=now() ORDER BY due LIMIT 1`,binding)).rows[0];
      const gap=(await database.pool.query<{workspace:string;gap_since:Date;gap_generation:string;gap_step:string;gap_position:GapPosition|null}>(`SELECT workspace,gap_since,gap_generation,gap_step,gap_position FROM ${liveState}
        WHERE namespace=$1 AND tenant=$2 AND organization=$3 AND gap_since IS NOT NULL AND retry_at<=now() ORDER BY retry_at,workspace LIMIT 1`,binding)).rows[0];
      if(!tail&&!gap){
        const pending=await database.pool.query<{delay:number|null}>(`SELECT ceil(extract(epoch FROM (min(at)-now()))*1000)::float8 AS delay FROM (
          SELECT min(due) AS at FROM ${tails} WHERE namespace=$1 AND tenant=$2 AND organization=$3 UNION ALL
          SELECT min(retry_at) FROM ${liveState} WHERE namespace=$1 AND tenant=$2 AND organization=$3 AND gap_since IS NOT NULL) pending`,binding);
        return Math.max(0,Math.min(60_000,pending.rows[0]?.delay??60_000));
      }
      const api=replicasLiveApi(envelope.open(identityPath,active.credential).toString(),scope.organizationId,signal,request);
      const who=await api.identity();
      if(who.caller!=='organization_api_key'||who.organization.id!==scope.organizationId)throw new Error('Replicas repair organization identity mismatch');
      if(tail){
        const tailKey=[...binding,tail.workspace,tail.chat,tail.generation,tail.tail_id];
        try{
          const history=await api.history({workspace_id:tail.workspace,chat_id:tail.chat});
          await hold(active,async tx=>{
            await capture(tx,tail.workspace,tail.chat,history,'history');
            await tx.query(`DELETE FROM ${tails} WHERE namespace=$1 AND tenant=$2 AND organization=$3 AND workspace=$4 AND chat=$5 AND generation=$6 AND tail_id=$7`,tailKey);
          });
        }catch(error){
          signal.throwIfAborted();
          diagnostic(scope,'turn_history',error);
          await hold(active,async tx=>{await tx.query(`UPDATE ${tails} SET due=now()+$8*interval '1 millisecond' WHERE namespace=$1 AND tenant=$2 AND organization=$3 AND workspace=$4 AND chat=$5 AND generation=$6 AND tail_id=$7`,[...tailKey,Math.max(30000,retry(error,1))]);});
        }
      }
      if(!gap)return 0;
      const {workspace,gap_since:since,gap_generation:generation}=gap;
      const stateKey=[...binding,workspace,generation,gap.gap_step];
      const fence='namespace=$1 AND tenant=$2 AND organization=$3 AND workspace=$4 AND gap_generation=$5 AND gap_step=$6 AND gap_since IS NOT NULL';
      const position:GapPosition=gap.gap_position?.generation===generation ? gap.gap_position :
        {generation,catalog:null,catalogCursors:[],chats:[],before:null,historyCursors:[],occurrences:{}};
      const checkpoint=async(tx:ApplicationTransaction)=>{
        const done=!position.catalog&&!position.chats.length;
        await tx.query(`UPDATE ${liveState} SET gap_since=CASE WHEN $7 THEN NULL ELSE gap_since END,gap_position=$8::jsonb,gap_step=gap_step+1,retry_at=now() WHERE ${fence}`,
          [...stateKey,done,done?null:JSON.stringify(position)]);
      };
      try{
        const chat=position.chats[0];
        if(chat){
          if(chat.workspace_id!==workspace)throw new Error('Replicas workspace export scope mismatch');
          const history=await api.history(chat,position.before);
          const next=history.before_cursor??null;
          if(history.has_more&&!next||next&&position.historyCursors.includes(next))throw new Error('Invalid Replicas history continuation');
          await hold(active,async tx=>{
            await capture(tx,workspace,chat.chat_id,history,'history','[Replicas history] '+(chat.title??chat.workspace_name),position.occurrences,chat);
            const times=history.events.map(e=>Date.parse(String(record(e)?.timestamp)));
            if(next&&(history.codex_asp_transcript||!times.length||!times.every(t=>Number.isFinite(t)&&t<since.getTime()))){
              position.before=next;position.historyCursors.push(next);
            }else{
              position.chats.shift();position.before=null;position.historyCursors=[];position.occurrences={};
            }
            await checkpoint(tx);
          });
        }else{
          const page=await api.conversations(position.catalog,workspace);
          if(page.conversations.some(chat=>chat.workspace_id!==workspace))throw new Error('Replicas workspace export scope mismatch');
          const next=page.next_cursor;
          if(next&&position.catalogCursors.includes(next))throw new Error('Repeated Replicas catalog cursor');
          if(next)position.catalogCursors.push(next);
          position.catalog=next;
          position.chats=page.conversations.filter(chat=>!(Date.parse(chat.updated_at)<since.getTime()));
          await hold(active,checkpoint);
        }
      }catch(error){
        signal.throwIfAborted();
        diagnostic(scope,'gap_history',error);
        await hold(active,async tx=>{await tx.query(`UPDATE ${liveState} SET retry_at=now()+$7*interval '1 millisecond' WHERE ${fence}`,[...stateKey,Math.max(30000,retry(error,1))]);});
      }
      return 0;
    }

    async function follow(active:Connection,leader:AbortSignal){
      const controller=new AbortController(),signal=AbortSignal.any([leader,controller.signal]);
      const api=replicasLiveApi(envelope.open(identityPath,active.credential).toString(),scope.organizationId,signal,request);
      const who=await api.identity();
      if(who.caller!=='organization_api_key'||who.organization.id!==scope.organizationId)throw new Error('Replicas live organization identity mismatch');
      const streams=new Map<string,{stop:AbortController;run:Promise<void>}>();
      // Starting the durable consumer before streaming also recovers a crash
      // between the first committed intent and its first wake.
      notifyRepair(active);
      try{
        while(!signal.aborted){
          const current=await database.pool.query<Connection>(connectionSql,binding);
          if(current.rows[0]?.id!==active.id||!current.rows[0]?.credential.equals(active.credential))return;
          dispatchRepair();
          const workspaces=await api.activeWorkspaces();
          for(const [id,s] of streams)if(!workspaces.has(id))s.stop.abort();
          for(const id of workspaces)if(!streams.has(id)){
            const stop=new AbortController();
            const run=collectWorkspace(active,api,id,AbortSignal.any([signal,stop.signal])).finally(()=>streams.delete(id));
            streams.set(id,{stop,run});
          }
          await pause(1500,signal);
        }
      }finally{controller.abort();await Promise.allSettled([...streams.values()].map(s=>s.run));}
    }
    let initialized=false,attempt=0;
    const registered=scopeKey(scope);
    repairs.set(registered,repair);
    while(!stop.aborted){
      try{
        await ready();
        const found=await database.pool.query<Connection>(connectionSql,binding);
        const active=found.rows[0];
        if(!active){await pause(5000,stop);continue;}
        const client=await database.pool.connect();
        const lost=new AbortController(),onError=()=>lost.abort();
        client.on('error',onError);
        try{
          const lock='replicas-live:'+JSON.stringify(binding);
          const locked=await client.query<{ok:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[lock]);
          if(locked.rows[0]?.ok){
            try{
              if(!initialized){
                await client.query(`CREATE TABLE IF NOT EXISTS ${liveState}(namespace text NOT NULL,tenant text NOT NULL,organization text NOT NULL,
                  workspace text NOT NULL,cursor text,observed_at timestamptz,gap_since timestamptz,gap_generation bigint NOT NULL DEFAULT 0,retry_at timestamptz NOT NULL DEFAULT now(),
                  PRIMARY KEY(namespace,tenant,organization,workspace))`);
                await client.query(`CREATE TABLE IF NOT EXISTS ${tails}(namespace text NOT NULL,tenant text NOT NULL,organization text NOT NULL,
                  workspace text NOT NULL,chat text NOT NULL,generation bigint NOT NULL DEFAULT 1,due timestamptz NOT NULL DEFAULT now(),
                  PRIMARY KEY(namespace,tenant,organization,workspace,chat))`);
                await client.query(`ALTER TABLE ${liveState} ADD COLUMN IF NOT EXISTS gap_position jsonb, ADD COLUMN IF NOT EXISTS gap_step bigint NOT NULL DEFAULT 0`);
                // A completed and recreated tail starts a fresh generation sequence.
                await client.query(`ALTER TABLE ${tails} ADD COLUMN IF NOT EXISTS tail_id uuid NOT NULL DEFAULT gen_random_uuid()`);
                initialized=true;
              }
              await follow(active,AbortSignal.any([stop,lost.signal]));attempt=0;
            }finally{if(!lost.signal.aborted)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]);}
          }
        }finally{client.removeListener('error',onError);client.release(lost.signal.aborted);}
        await pause(1000,stop);
      }catch(error){if(!stop.aborted){diagnostic(scope,'discovery',error);await pause(retry(error,attempt++),stop);}}
    }
    await waking;
  }
  return {runLiveCapture:run,async repairLiveCapture(job:ReplicasRepairJob,signal:AbortSignal){
    return await repairs.get(scopeKey(job))?.(job,signal)??null;
  }};
}
