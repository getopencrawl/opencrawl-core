import {scanTargetInventoryIn,assertTargetInventoryBoundIn,targetInventoryFailure,targetInventoryValueBytes,type OnlineOwnedInventoryItem} from './online-target-inventory-support.mjs';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {directPostListener, wakeKey, type BoardWake} from './board-wake.mjs';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import type {BoardState,BoardMessage,Participant,Delivery} from '../board/types.mjs';
import {systemIdentity,announcementChannel} from '../board/channels.mjs';
import {agentMessage, selectMessage, type AgentMessageSource, type MessageField} from '../board/messages.mjs';
import {boardIdentity} from '../board/identity.mjs';

const fail=(message:string,status=503)=>Object.assign(new Error(message),{status});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const visible=({requestId,publication,captureRef,onlineAudience,...message}:BoardMessage)=>message;
export interface BoardMetadata {head:number;usage:BoardState['usage'];participantsPresent:boolean}
export type BoardProfile=Omit<Participant,'pending'>&{pending:(Omit<Delivery,'messages'>&{count:number})|null};
export interface BoardReader {
  metadata():Promise<BoardMetadata>;
  headBefore(time:number):Promise<number>;
  blockedPublications(agents:string[]):Promise<string[]>;
  message(id:number):Promise<BoardMessage|null>;
  messagesByIds(ids:number[]):Promise<BoardMessage[]>;
  agentMessagesByIds(ids:number[],fields?:MessageField[]):Promise<ReturnType<typeof selectMessage>[]>;
  agentNames(ids:string[]):Promise<Record<string,string>>;
  replyCounts(roots:number[]):Promise<Record<number,number>>;
  messages(input:{before?:number;after?:number;through?:number;topic?:string;threadId?:number;rootsOnly?:boolean;limit:number;descending?:boolean}):Promise<BoardMessage[]>;
  participant(id:string):Promise<Participant|null>;
  participants():Promise<Record<string,Participant>>;
  profiles():Promise<Record<string,Omit<Participant,'pending'>>>;
  profileByName(name:string,userId:string):Promise<{id:string;name:string}|null>;
  onlinePeers(except:string,cutoff:number):Promise<Array<{agent:string;name:string;task:string;captureRef?:string}>>;
  sharedUpdates(input:{after:number;through:number;channels?:string[];limit:number}):Promise<BoardMessage[]>;
  agentProfiles(input:{after:number;limit:number;cutoff:number;active:boolean;query:string}):Promise<Array<Omit<Participant,'pending'>>>;
  directory(input:{after:number;limit:number;cutoff:number}):Promise<{agents:Array<{id:string;participant:BoardProfile}>;total:number}>;
  agents():Promise<BoardState['agents']>;
  topics():Promise<Array<{topic:string;posts:number;first:number;latest:{id:number;timestamp:number;name:string}}>>;
  unread(input:{delivery?:'direct'|'routine';after:number;through:number;topics:string[];mention?:string;userId:string;agent:string;name:string;limit:number}):Promise<BoardMessage[]>;
  publication(input:{userId:string;agent:string;name:string;requestId:string;registered:boolean}):Promise<BoardMessage|null>;
}
export interface BoardTransaction extends BoardReader {
  blockPublication(agent:string):Promise<void>;
  prepareRegistration(id:string,name:string|undefined,cutoff:number):Promise<void>;
  refreshAgent(id:string,name:string,seen:number):Promise<void>;
  expireAgents(cutoff:number):Promise<void>;
  publicationBlocked(agent:string):Promise<boolean>;
  putParticipant(id:string,value:Participant):Promise<void>;
  removeParticipant(id:string):Promise<void>;
  putAgent(id:string,value:BoardState['agents'][string]):Promise<void>;
  removeAgent(id:string):Promise<void>;
  append(message:Omit<BoardMessage,'id'>):Promise<BoardMessage>;
  addUsage(inputBytes:number,outputBytes:number):Promise<void>;
}
export interface BoardSearchInput {query:string;topics:string[];agents:string[];authors:string[];since?:string;until?:string;sort:'relevance'|'newest'|'oldest';after?:number;before?:number;thread?:number;rootsOnly?:boolean;limit:number;facets:Array<'topic'|'agent'|'author'|'day'>;facetSize:number;cursor?:string}
export interface SearchFacet {values:Array<{value:string;count:number;name?:string}>;other:number}
interface SearchSnapshot {through:number;total:number;facets:Record<string,SearchFacet>}
interface SearchBoundary {rank:number;stamp:number;id:number}
interface RankedMessage<T> {record:T;id:string;stamp:string;rank:number}
interface SearchPage<T> {total:number;through:number;messages:T[];facets?:Record<string,SearchFacet>;next:string|null}
export interface BoardRepository {
  watchDirect?(tenantHash:string):Promise<BoardWake>;
  read<T>(tenantHash:string,run:(reader:BoardReader)=>Promise<T>):Promise<T>;
  transaction<T>(tenantHash:string,run:(transaction:BoardTransaction)=>Promise<T>):Promise<T>;
  search(tenantHash:string,userId:string,args:BoardSearchInput,now:number):Promise<SearchPage<ReturnType<typeof visible>>>;
  searchAgentMessages(tenantHash:string,userId:string,args:BoardSearchInput,now:number,fields?:MessageField[]):Promise<SearchPage<ReturnType<typeof selectMessage>>>;
}

// Read small indexed columns directly and keep unrequested bodies in PostgreSQL.
function agentRecordSql(fields?:MessageField[]) {
  const include=(field:MessageField)=>!fields || fields.includes(field);
  return `jsonb_build_object('id',m.id,'name',m.name,'topic',m.topic,'timestamp',m.stamp,
    'text',${include('text')?"m.record->'text'":"''::text"},'threadId',m.record->'threadId','replyTo',m.record->'replyTo',
    'mentions',${include('mentions')?"m.record->'mentions'":"null"},'mentionNames',${include('mentions')?"m.record->'mentionNames'":"null"})`;
}
async function projectAgentMessages(reader:BoardReader,rows:AgentMessageSource[],fields?:MessageField[]) {
  const names=await reader.agentNames([...new Set(rows.flatMap(row=>row.mentionNames?[]:row.mentions??[]))]);
  return rows.map(row=>selectMessage(agentMessage(row,names),fields));
}

function boardMessageChunks(message:Pick<BoardMessage,'topic'|'text'>){
 const chunks:string[]=[];let start=0;const body=message.topic+' '+message.text;
 while(start<body.length){let end=Math.min(start+32768,body.length);while(end<body.length&&!/\s/.test(body[end]))end++;chunks.push(body.slice(start,end));start=end;}return chunks;
}

// Bound both parameter bytes and rows. A single already-validated large
// publication can exceed the byte target; never split its JSON record.
function* boardBatches<T>(rows:Iterable<T>):Generator<T[]>{
 let batch:T[]=[],bytes=0;
 for(const row of rows){const size=Buffer.byteLength(JSON.stringify(row));if(batch.length&&(batch.length>=128||bytes+size>256*1024)){yield batch;batch=[];bytes=0;}batch.push(row);bytes+=size;}
 if(batch.length)yield batch;
}

export function createPostgresBoardState(database:ApplicationDatabase) {
  const listen = directPostListener(database.pool);
  const {namespace}=database;
  async function ready(){await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl-board-schema-v1',0))");await client.query(`
    CREATE TABLE IF NOT EXISTS opencrawl_board_heads(namespace text NOT NULL,tenant_hash text NOT NULL,head bigint NOT NULL DEFAULT 0 CHECK(head>=0),usage jsonb NOT NULL,participants_present boolean NOT NULL DEFAULT false,PRIMARY KEY(namespace,tenant_hash));
    CREATE TABLE IF NOT EXISTS opencrawl_board_private_sessions(namespace text NOT NULL,tenant_hash text NOT NULL,agent text NOT NULL,PRIMARY KEY(namespace,tenant_hash,agent),FOREIGN KEY(namespace,tenant_hash) REFERENCES opencrawl_board_heads ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_messages(namespace text NOT NULL,tenant_hash text NOT NULL,id bigint NOT NULL,stamp bigint NOT NULL,agent text NOT NULL,author text NOT NULL,name text NOT NULL,topic text NOT NULL,request_id text NOT NULL,legacy_agent boolean NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,tenant_hash,id),FOREIGN KEY(namespace,tenant_hash) REFERENCES opencrawl_board_heads ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_search_chunks(namespace text NOT NULL,tenant_hash text NOT NULL,message_id bigint NOT NULL,ordinal integer NOT NULL,words tsvector NOT NULL,PRIMARY KEY(namespace,tenant_hash,message_id,ordinal),FOREIGN KEY(namespace,tenant_hash,message_id) REFERENCES opencrawl_board_messages ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_topics(namespace text NOT NULL,tenant_hash text NOT NULL,topic text NOT NULL,first_id bigint NOT NULL,posts bigint NOT NULL,latest jsonb NOT NULL,PRIMARY KEY(namespace,tenant_hash,topic),FOREIGN KEY(namespace,tenant_hash) REFERENCES opencrawl_board_heads ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_agents(namespace text NOT NULL,tenant_hash text NOT NULL,agent text NOT NULL,record jsonb NOT NULL,position bigint NOT NULL DEFAULT 0,PRIMARY KEY(namespace,tenant_hash,agent),FOREIGN KEY(namespace,tenant_hash) REFERENCES opencrawl_board_heads ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_participants(namespace text NOT NULL,tenant_hash text NOT NULL,agent text NOT NULL,user_id text,name text NOT NULL,seen bigint NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,tenant_hash,agent),FOREIGN KEY(namespace,tenant_hash) REFERENCES opencrawl_board_heads ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_deliveries(namespace text NOT NULL,tenant_hash text NOT NULL,agent text NOT NULL,receipt text NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,tenant_hash,agent),FOREIGN KEY(namespace,tenant_hash,agent) REFERENCES opencrawl_board_participants ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_delivery_messages(namespace text NOT NULL,tenant_hash text NOT NULL,agent text NOT NULL,ordinal integer NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,tenant_hash,agent,ordinal),FOREIGN KEY(namespace,tenant_hash,agent) REFERENCES opencrawl_board_deliveries ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_search_snapshots(namespace text NOT NULL,token uuid NOT NULL,tenant_hash text NOT NULL,owner text NOT NULL,expires bigint NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,token),FOREIGN KEY(namespace,tenant_hash) REFERENCES opencrawl_board_heads ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS opencrawl_board_search_pages(namespace text NOT NULL,token uuid NOT NULL,offset_value bigint NOT NULL,boundary jsonb NOT NULL,PRIMARY KEY(namespace,token,offset_value),FOREIGN KEY(namespace,token) REFERENCES opencrawl_board_search_snapshots ON DELETE CASCADE);
  `);
    await ensureSchemaIndex(client,{table:'opencrawl_board_messages',name:'opencrawl_board_messages_topic',keys:['namespace','tenant_hash','topic','id']});
    await ensureSchemaIndex(client,{table:'opencrawl_board_messages',name:'opencrawl_board_messages_thread',keys:['namespace','tenant_hash',"(((record ->> 'threadId'::text))::bigint)",'id'],jsonKey:{column:'record',key:'threadId'}});
    await ensureSchemaIndex(client,{table:'opencrawl_board_messages',name:'opencrawl_board_messages_publication',keys:['namespace','tenant_hash','author','request_id','agent','id']});
    await ensureSchemaIndex(client,{table:'opencrawl_board_messages',name:'opencrawl_board_messages_mentions',method:'gin',keys:["((record -> 'mentions'::text))"]});
    await ensureSchemaIndex(client,{table:'opencrawl_board_search_chunks',name:'opencrawl_board_search_words',method:'gin',keys:['words']});
    await ensureSchemaIndex(client,{table:'opencrawl_board_participants',name:'opencrawl_board_participants_name',keys:['namespace','tenant_hash','lower(name)']});
    await ensureSchemaIndex(client,{table:'opencrawl_board_participants',name:'opencrawl_board_participants_seen',keys:['namespace','tenant_hash','seen DESC','agent']});
    await ensureSchemaIndex(client,{table:'opencrawl_board_search_snapshots',name:'opencrawl_board_search_snapshots_expiry',keys:['namespace','expires']});
  });}
  function tenant(value:string){if(!/^[a-f0-9]{64}$/.test(value))throw fail('Invalid board tenant identity',400);return value;}
  function accessor(client:PoolClient,key:string):BoardTransaction {
    const scope=[namespace,tenant(key)];
    const query=(sql:string,values:unknown[]=[])=>client.query(sql,[...scope,...values]);
    async function blockedPublications(agents:string[]):Promise<string[]>{
      if(!agents.length)return [];
      const result=await query('SELECT agent FROM opencrawl_board_private_sessions WHERE namespace=$1 AND tenant_hash=$2 AND agent=ANY($3::text[])',[agents]);
      return result.rows.map(row=>row.agent);
    }
    async function metadata(){const row=(await query('SELECT head,usage,participants_present FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash=$2')).rows[0];return {head:Number(row?.head??0),usage:row?.usage??{calls:0,inputBytes:0,outputBytes:0},participantsPresent:row?.participants_present??false};}
    async function pending(id:string):Promise<Delivery|null>{const row=(await query('SELECT record FROM opencrawl_board_deliveries WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id])).rows[0];if(!row)return null;const rows=await query('SELECT record FROM opencrawl_board_delivery_messages WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3 ORDER BY ordinal',[id]);return {...row.record,messages:rows.rows.map(row=>row.record)};}
    async function putParticipant(id:string,value:Participant){const {pending:delivery,...record}=value;
      await query(`INSERT INTO opencrawl_board_participants VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,tenant_hash,agent) DO UPDATE SET user_id=EXCLUDED.user_id,name=EXCLUDED.name,seen=EXCLUDED.seen,record=EXCLUDED.record`,[id,value.userId??null,value.name,value.seen,record]);
      await query('UPDATE opencrawl_board_heads SET participants_present=true WHERE namespace=$1 AND tenant_hash=$2');
      if(!delivery){await query('DELETE FROM opencrawl_board_deliveries WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id]);return;}
      const current=(await query('SELECT receipt FROM opencrawl_board_deliveries WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id])).rows[0];
      if(current?.receipt===delivery.receipt)return;
      await query('DELETE FROM opencrawl_board_deliveries WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id]);
      const {messages,...header}=delivery;
      await query('INSERT INTO opencrawl_board_deliveries VALUES($1,$2,$3,$4,$5)',[id,delivery.receipt,header]);
      for(let index=0;index<messages.length;index++)await query('INSERT INTO opencrawl_board_delivery_messages VALUES($1,$2,$3,$4,$5)',[id,index,messages[index]]);
    }
    async function insertMessage(message:BoardMessage){
      await query('INSERT INTO opencrawl_board_messages VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[message.id,message.timestamp,message.agent,message.author,message.name,message.topic,message.requestId,message.agent===boardIdentity(message.author,message.name),message]);
      // Bounded vectors preserve search across large messages without PostgreSQL's
      // 1 MiB tsvector ceiling. Chunk at whitespace so a word never gets split.
      const chunks=boardMessageChunks(message);
      for(let index=0;index<chunks.length;index++)await query("INSERT INTO opencrawl_board_search_chunks VALUES($1,$2,$3,$4,to_tsvector('simple',$5))",[message.id,index,chunks[index]]);
      await query(`INSERT INTO opencrawl_board_topics VALUES($1,$2,$3,$4,1,$5) ON CONFLICT(namespace,tenant_hash,topic) DO UPDATE SET posts=opencrawl_board_topics.posts+1,latest=EXCLUDED.latest`,[message.topic,message.id,{id:message.id,timestamp:message.timestamp,name:message.name||message.agent}]);
    }
    return {metadata,
      async message(id){return (await query('SELECT record FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND id=$3',[id])).rows[0]?.record??null;},
      async headBefore(time){const row=(await query('SELECT id FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND stamp<$3 ORDER BY id DESC LIMIT 1',[time])).rows[0];return Number(row?.id??0);},
      async messagesByIds(ids){return (await query('SELECT record FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND id=ANY($3::bigint[])',[ids])).rows.map(row=>row.record);},
      async agentMessagesByIds(ids,fields){
        const result=await query(`SELECT ${agentRecordSql(fields)} AS record FROM opencrawl_board_messages m
          WHERE m.namespace=$1 AND m.tenant_hash=$2 AND m.id=ANY($3::bigint[])`,[ids]);
        return projectAgentMessages(accessor(client,key),result.rows.map(row=>row.record),fields);
      },
      async agentNames(ids){
        if(!ids.length)return {};
        const rows=await query(`SELECT DISTINCT ON(agent) agent,name FROM (
          SELECT agent,name,0 priority,0::bigint id FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND agent=ANY($3::text[])
          UNION ALL SELECT agent,name,1 priority,id FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND agent=ANY($3::text[])
        ) names ORDER BY agent,priority,id DESC`,[ids]);
        return Object.fromEntries(rows.rows.map(row=>[row.agent,row.name]));
      },
      async replyCounts(roots){
        if(roots.length>21||roots.some(id=>!Number.isSafeInteger(id)||id<1))throw fail('Invalid thread count selection',400);
        if(!roots.length)return {};
        const rows=await query("SELECT (record->>'threadId')::bigint AS root,count(*) AS replies FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND record ? 'threadId' AND (record->>'threadId')::bigint=ANY($3::bigint[]) GROUP BY (record->>'threadId')::bigint",[roots]);
        return Object.fromEntries(rows.rows.map(row=>[Number(row.root),Number(row.replies)]));
      },
      async messages({before,after,through,topic,threadId,rootsOnly=false,limit,descending=false}){if(!Number.isSafeInteger(limit)||limit<1||limit>250)throw fail('Invalid board page');return (await query(`SELECT record FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND ($3::bigint IS NULL OR id<$3) AND ($4::bigint IS NULL OR id>$4) AND ($5::bigint IS NULL OR id<=$5) AND ($6::text IS NULL OR topic=$6) ${threadId!==undefined?"AND record ? 'threadId'":''} AND ($8::bigint IS NULL OR (record->>'threadId')::bigint=$8) AND (NOT $9::boolean OR NOT record ? 'threadId') ORDER BY id ${descending?'DESC':'ASC'} LIMIT $7`,[before??null,after??null,through??null,topic??null,limit,threadId??null,rootsOnly])).rows.map(row=>row.record);},
      async blockPublication(agent){await query('INSERT INTO opencrawl_board_private_sessions(namespace,tenant_hash,agent) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[agent]);},
      blockedPublications,
      async publicationBlocked(agent){return (await blockedPublications([agent])).length>0;},
      async participant(id){const row=(await query('SELECT record FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id])).rows[0];return row?{...row.record,pending:await pending(id)}:null;},
      async participants(){
        const rows=(await query('SELECT agent,record FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 ORDER BY agent')).rows;
        const deliveries=new Map<string,Delivery>((await query('SELECT agent,record FROM opencrawl_board_deliveries WHERE namespace=$1 AND tenant_hash=$2')).rows.map(row=>[row.agent,{...row.record,messages:[]}]));
        for(const row of (await query('SELECT agent,record FROM opencrawl_board_delivery_messages WHERE namespace=$1 AND tenant_hash=$2 ORDER BY agent,ordinal')).rows)deliveries.get(row.agent)?.messages.push(row.record);
        return Object.fromEntries(rows.map(row=>[row.agent,{...row.record,pending:deliveries.get(row.agent)??null}]));
      },
      async profiles(){return Object.fromEntries((await query('SELECT agent,record FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 ORDER BY agent')).rows.map(row=>[row.agent,row.record]));},
      async profileByName(name,userId){
        const row=(await query('SELECT agent,name FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND user_id=$3 AND lower(name)=lower($4) LIMIT 1',[userId,name])).rows[0];
        return row?{id:row.agent,name:row.name}:null;
      },
      async onlinePeers(except,cutoff){
        return (await query(`SELECT agent,name,record->>'task' AS task,record->>'captureRef' AS capture_ref FROM opencrawl_board_participants
          WHERE namespace=$1 AND tenant_hash=$2 AND agent<>$3 AND seen>$4 AND coalesce(record->>'left','false')<>'true'
          ORDER BY agent`,[except,cutoff])).rows.map(row=>({agent:row.agent,name:row.name,task:row.task,captureRef:row.capture_ref??undefined}));
      },
      async sharedUpdates({after,through,channels,limit}){
        // A reader without a session can see shared board posts, never presence deliveries.
        return (await query(`SELECT record FROM opencrawl_board_messages
          WHERE namespace=$1 AND tenant_hash=$2 AND id>$3 AND id<=$4 AND NOT record ? 'onlineAudience'
          AND ($5::text[] IS NULL OR topic=ANY($5) OR (topic='opencrawl' AND record->>'system'='true' AND NOT record ? 'threadId'))
          ORDER BY id LIMIT $6`,[after,through,channels??null,limit])).rows.map(row=>row.record);
      },
      async agentProfiles({after,limit,cutoff,active,query:term}){
        return (await query(`SELECT record FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND name<>'' AND (NOT $3::boolean OR (seen>$4 AND coalesce(record->>'left','false')<>'true')) AND strpos(lower(name||' '||coalesce(record->>'task','')),lower($5))>0 ORDER BY seen DESC,agent LIMIT $6 OFFSET $7`,[active,cutoff,term,limit,after])).rows.map(row=>row.record);
      },
      async directory({after,limit,cutoff}){const total=Number((await query('SELECT count(*) count FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND seen>$3',[cutoff])).rows[0].count);const rows=(await query(`SELECT p.agent,p.record,d.record delivery,(SELECT count(*) FROM opencrawl_board_delivery_messages dm WHERE dm.namespace=p.namespace AND dm.tenant_hash=p.tenant_hash AND dm.agent=p.agent) delivery_count FROM opencrawl_board_participants p LEFT JOIN opencrawl_board_deliveries d USING(namespace,tenant_hash,agent) WHERE p.namespace=$1 AND p.tenant_hash=$2 AND p.seen>$3 ORDER BY p.seen DESC,p.agent LIMIT $4 OFFSET $5`,[cutoff,limit,after])).rows;return {total,agents:rows.map(row=>({id:row.agent,participant:{...row.record,pending:row.delivery?{...row.delivery,count:Number(row.delivery_count)}:null}}))};},
      async agents(){return Object.fromEntries((await query('SELECT agent,record FROM opencrawl_board_agents WHERE namespace=$1 AND tenant_hash=$2 ORDER BY position,agent')).rows.map(row=>[row.agent,row.record]));},
      async topics(){return (await query('SELECT topic,first_id,posts,latest FROM opencrawl_board_topics WHERE namespace=$1 AND tenant_hash=$2 ORDER BY first_id')).rows.map(row=>({topic:row.topic,first:Number(row.first_id),posts:Number(row.posts),latest:row.latest}));},
      async unread({after,through,topics,mention,userId,agent,name,limit,delivery}){return (await query(`SELECT m.record FROM opencrawl_board_messages m
        LEFT JOIN opencrawl_board_participants f ON f.namespace=m.namespace AND f.tenant_hash=m.tenant_hash AND f.agent=$8
        CROSS JOIN LATERAL (SELECT m.record ? 'threadId' AND coalesce(f.record->'mutedThreads','[]'::jsonb) @> jsonb_build_array((m.record->>'threadId')::bigint) AS muted) thread
        CROSS JOIN LATERAL (SELECT m.record->'mentions' ? $6 OR (m.record ? 'threadId' AND NOT thread.muted
          AND f.record->'followedThreads' @> jsonb_build_array((m.record->>'threadId')::bigint)) AS eligible) direct
        WHERE m.namespace=$1 AND m.tenant_hash=$2 AND m.id>$3 AND m.id<=$4
        AND (NOT m.record ? 'onlineAudience' OR m.record->'onlineAudience' ? $8)
        AND (CASE WHEN direct.eligible THEN $11::text IS DISTINCT FROM 'routine'
          ELSE $11::text IS DISTINCT FROM 'direct' AND (m.record->'onlineAudience' ? $8
            OR (m.topic='opencrawl' AND m.record->>'system'='true' AND NOT m.record ? 'threadId')
            OR (m.topic=ANY($5::text[]) AND NOT thread.muted)) END)
        AND NOT(m.author=$7 AND(m.agent=$8 OR(lower(m.name)=lower($9) AND(m.legacy_agent OR EXISTS(SELECT 1 FROM opencrawl_board_participants p WHERE p.namespace=m.namespace AND p.tenant_hash=m.tenant_hash AND p.agent=m.agent AND lower(p.name)=lower($9))))))
        ORDER BY m.id LIMIT $10`,[after,through,topics,mention??'',userId,agent,name,limit,delivery??null])).rows.map(row=>row.record);},
      async publication({userId,agent,name,requestId,registered}){return (await query(`SELECT record FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 AND author=$3 AND request_id=$4 AND(agent=$5 OR($6 AND lower(name)=lower($7) AND legacy_agent)) ORDER BY (agent=$5) DESC,id LIMIT 1`,[userId,requestId,agent,registered,name])).rows[0]?.record??null;},
      putParticipant,
      async prepareRegistration(id,name,cutoff){
        // The tenant head lock serializes expiry, name claims and the subsequent upsert.
        await query('DELETE FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND seen<=$3 AND agent<>$4',[cutoff,id]);
        if(name && (await query('SELECT 1 FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND lower(name)=lower($3) AND agent<>$4 LIMIT 1',[name,id])).rowCount)
          throw fail('Agent name is already registered; choose a session-specific name',409);
      },
      async refreshAgent(id,name,seen){
        await query(`UPDATE opencrawl_board_agents SET record=record || jsonb_build_object('name',$4::text,'seen',$5::bigint) WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3`,[id,name,seen]);
      },
      async expireAgents(cutoff){
        await query("DELETE FROM opencrawl_board_agents WHERE namespace=$1 AND tenant_hash=$2 AND (record->>'seen')::bigint<=$3",[cutoff]);
      },
      async removeParticipant(id){await query('DELETE FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id]);},
      async putAgent(id,value){await query('INSERT INTO opencrawl_board_agents(namespace,tenant_hash,agent,record,position) VALUES($1,$2,$3,$4,(SELECT coalesce(max(position),0)+1 FROM opencrawl_board_agents WHERE namespace=$1 AND tenant_hash=$2)) ON CONFLICT(namespace,tenant_hash,agent) DO UPDATE SET record=EXCLUDED.record',[id,value]);},
      async removeAgent(id){await query('DELETE FROM opencrawl_board_agents WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[id]);},
      async append(input){const result=await query('UPDATE opencrawl_board_heads SET head=head+1 WHERE namespace=$1 AND tenant_hash=$2 RETURNING head');const message={...input,id:Number(result.rows[0].head)};if(!Number.isSafeInteger(message.id))throw fail('Board sequence exhausted');await insertMessage(message);
        if (message.threadId !== undefined || message.mentions?.length) {
          await client.query("SELECT pg_notify('opencrawl_board_direct', $1)", [wakeKey(namespace,key)]);
        }
        return message;},
      async addUsage(inputBytes,outputBytes){await query(`UPDATE opencrawl_board_heads SET usage=jsonb_build_object('calls',(usage->>'calls')::bigint+1,'inputBytes',(usage->>'inputBytes')::bigint+$3,'outputBytes',(usage->>'outputBytes')::bigint+$4) WHERE namespace=$1 AND tenant_hash=$2`,[inputBytes,outputBytes]);},
    };
  }
  async function initialize(client:PoolClient,key:string){await client.query('INSERT INTO opencrawl_board_heads(namespace,tenant_hash,usage) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[namespace,tenant(key),{calls:0,inputBytes:0,outputBytes:0}]);}
  async function transaction<T>(key:string,run:(tx:BoardTransaction)=>Promise<T>):Promise<T>{return database.transaction(async client=>{await initialize(client,key);await client.query('SELECT head FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash=$2 FOR UPDATE',[namespace,key]);return run(accessor(client,key));});}
  async function read<T>(key:string,run:(tx:BoardReader)=>Promise<T>):Promise<T>{return database.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return run(accessor(client,key));});}
  async function exportIn(client:PoolClient,key:string):Promise<BoardState|null>{const tx=accessor(client,key);const exists=(await client.query('SELECT 1 FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash=$2',[namespace,key])).rowCount;if(!exists)return null;const meta=await tx.metadata(),messages:BoardMessage[]=[];for(let after=0;;){const page=await tx.messages({after,limit:250});if(!page.length)break;messages.push(...page);after=page.at(-1)!.id;}return {schema:1,messages,agents:await tx.agents(),usage:meta.usage,...(meta.participantsPresent?{participants:await tx.participants()}: {})};}
  async function exportLegacy(key:string){return database.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return exportIn(client,tenant(key));});}
  async function insertMessagesIn(client:PoolClient,key:string,messages:BoardMessage[]){
    for(const batch of boardBatches(messages)){
      await client.query(`INSERT INTO opencrawl_board_messages(namespace,tenant_hash,id,stamp,agent,author,name,topic,request_id,legacy_agent,record)
        SELECT $1,$2,(record->>'id')::bigint,(record->>'timestamp')::bigint,record->>'agent',record->>'author',record->>'name',record->>'topic',record->>'requestId',legacy_agent,record
        FROM jsonb_to_recordset($3::jsonb) AS x(record jsonb,legacy_agent boolean)`,[namespace,key,JSON.stringify(batch.map(record=>({record,legacy_agent:record.agent===boardIdentity(record.author,record.name)})))]);
      function* chunks(){for(const message of batch){let ordinal=0;for(const text of boardMessageChunks(message))yield {id:message.id,ordinal:ordinal++,text};}}
      for(const chunkBatch of boardBatches(chunks()))await client.query(`INSERT INTO opencrawl_board_search_chunks(namespace,tenant_hash,message_id,ordinal,words)
        SELECT $1,$2,id,ordinal,to_tsvector('simple',text) FROM jsonb_to_recordset($3::jsonb) AS x(id bigint,ordinal integer,text text)`,[namespace,key,JSON.stringify(chunkBatch)]);
      const topics=new Map<string,{topic:string;first:number;posts:number;latest:{id:number;timestamp:number;name:string}}>();
      for(const message of batch){const previous=topics.get(message.topic);topics.set(message.topic,{topic:message.topic,first:previous?.first??message.id,posts:(previous?.posts??0)+1,latest:{id:message.id,timestamp:message.timestamp,name:message.name||message.agent}});}
      await client.query(`INSERT INTO opencrawl_board_topics(namespace,tenant_hash,topic,first_id,posts,latest)
        SELECT $1,$2,topic,first,posts,latest FROM jsonb_to_recordset($3::jsonb) AS x(topic text,first bigint,posts bigint,latest jsonb)
        ON CONFLICT(namespace,tenant_hash,topic) DO UPDATE SET posts=opencrawl_board_topics.posts+EXCLUDED.posts,latest=EXCLUDED.latest`,[namespace,key,JSON.stringify([...topics.values()])]);
    }
  }
  async function insertLegacyIn(client:PoolClient,key:string,state:BoardState){
    await initialize(client,key);const tx=accessor(client,key);await insertMessagesIn(client,key,state.messages);
    for(const [id,value]of Object.entries(state.agents))await tx.putAgent(id,value);
    for(const [id,value]of Object.entries(state.participants??{}))await tx.putParticipant(id,value);
    await client.query('UPDATE opencrawl_board_heads SET usage=$3,participants_present=$4,head=$5 WHERE namespace=$1 AND tenant_hash=$2',[namespace,key,state.usage,state.participants!==undefined,state.messages.length]);
  }
  async function projectIn(client:PoolClient,key:string,state:BoardState|null){
    tenant(key);if(state!==null)validateLegacyBoard(state);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['board-import',namespace,key])]);
    await client.query('SELECT head FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash=$2 FOR UPDATE',[namespace,key]);
    const prior=await exportIn(client,key);
    // Legacy publications are append-only. Replay heartbeats, acknowledgments,
    // subscriptions and new publications without rewriting unchanged history.
    // An arbitrary replacement/deletion still has the original exact semantics.
    if(state&&prior&&prior.messages.length<=state.messages.length&&prior.messages.every((message,index)=>isDeepStrictEqual(message,state.messages[index]))){
      await insertMessagesIn(client,key,state.messages.slice(prior.messages.length));
      const tx=accessor(client,key);
      if(!isDeepStrictEqual(Object.entries(prior.agents),Object.entries(state.agents))){
        await client.query('DELETE FROM opencrawl_board_agents WHERE namespace=$1 AND tenant_hash=$2',[namespace,key]);
        for(const [id,value]of Object.entries(state.agents))await tx.putAgent(id,value);
      }
      for(const id of new Set([...Object.keys(prior.participants??{}),...Object.keys(state.participants??{})])){
        const before=prior.participants?.[id],after=state.participants?.[id];if(isDeepStrictEqual(before,after))continue;
        // Replace only this participant's delivery, even if a legacy snapshot
        // reused its receipt with different contents; final readback is exact.
        if(before)await tx.removeParticipant(id);if(after)await tx.putParticipant(id,after);
      }
      await client.query('UPDATE opencrawl_board_heads SET usage=$3,participants_present=$4,head=$5 WHERE namespace=$1 AND tenant_hash=$2',[namespace,key,state.usage,state.participants!==undefined,state.messages.length]);
    }else{
      await client.query('DELETE FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash=$2',[namespace,key]);
      if(state!==null)await insertLegacyIn(client,key,state);
    }
    if(!isDeepStrictEqual(await exportIn(client,key),state))throw fail('Board projection verification failed');
  }
  async function importLegacy(key:string,state:BoardState){validateLegacyBoard(state);await database.transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['board-import',namespace,tenant(key)])]);
    const existing=await exportIn(client,key);if(existing){if(!isDeepStrictEqual(existing,state))throw fail('Conflicting PostgreSQL board state',409);return;}
    await insertLegacyIn(client,key,state);
    if(!isDeepStrictEqual(await exportIn(client,key),state))throw fail('Board migration verification failed');
  });}
  function search(key:string,userId:string,args:BoardSearchInput,time:number){
    return searchPage<BoardMessage,ReturnType<typeof visible>>(key,userId,args,time,'m.record',undefined,
      async (_reader,rows)=>rows.map(visible));
  }
  function searchAgentMessages(key:string,userId:string,args:BoardSearchInput,time:number,fields?:MessageField[]){
    return searchPage<AgentMessageSource,ReturnType<typeof selectMessage>>(key,userId,args,time,agentRecordSql(fields),fields,
      (reader,rows)=>projectAgentMessages(reader,rows,fields));
  }
  async function searchPage<Row,Output>(key:string,userId:string,args:BoardSearchInput,time:number,record:string,fields:MessageField[]|undefined,
    project:(reader:BoardReader,rows:Row[])=>Promise<Output[]>){
    for(const id of [args.after,args.before,args.thread])if(id!==undefined&&(!Number.isSafeInteger(id)||id<0))throw fail('Invalid message boundary',400);
    const {cursor,...parameters}=args,owner=hash(JSON.stringify([namespace,key,userId,parameters,...fields?[fields]:[]]));
    return database.transaction(async client=>{await initialize(client,key);await client.query('SET LOCAL statement_timeout=15000');
      let token:string,offset=0,snapshot:SearchSnapshot,boundary:SearchBoundary|undefined;
      if(cursor){const match=/^([a-f0-9-]{36}):(\d{1,16})$/.exec(cursor);if(!match)throw fail('Invalid search cursor',400);token=match[1];offset=Number(match[2]);if(!Number.isSafeInteger(offset))throw fail('Invalid search cursor',400);
        const row=(await client.query<{record:SearchSnapshot}>('SELECT record FROM opencrawl_board_search_snapshots WHERE namespace=$1 AND token=$2 AND tenant_hash=$3 AND owner=$4 AND expires>$5',[namespace,token,key,owner,time])).rows[0];if(!row)throw fail('Search cursor expired or does not match this workspace/query; restart search',409);snapshot=row.record;
        const page=(await client.query<{boundary:SearchBoundary}>('SELECT boundary FROM opencrawl_board_search_pages WHERE namespace=$1 AND token=$2 AND offset_value=$3',[namespace,token,offset])).rows[0];if(!page||offset>=snapshot.total)throw fail('Invalid search cursor',409);boundary=page.boundary;
      }else{token=randomUUID();snapshot={through:(await accessor(client,key).metadata()).head,total:0,facets:{}};}
      const terms=(await client.query("SELECT tsvector_to_array(to_tsvector('simple',$1)) terms",[args.query])).rows[0].terms as string[];
      const values:unknown[]=[namespace,key,snapshot.through,args.topics,args.agents,args.authors,args.since?Date.parse(args.since):null,args.until?Date.parse(args.until):null,terms];
      const matching=args.query?`matched AS MATERIALIZED(SELECT c.message_id FROM unnest($9::text[]) AS terms(term) JOIN opencrawl_board_search_chunks c ON c.words @@ plainto_tsquery('simple',terms.term) WHERE c.namespace=$1 AND c.tenant_hash=$2 AND c.message_id<=$3 GROUP BY c.message_id HAVING count(DISTINCT terms.term)=cardinality($9::text[]))`:'';
      const withMatches=matching?'WITH '+matching+' ':'';
      // Resolve matching IDs as one scoped set. A correlated anti-join can scan
      // the chunks relation once per message when PostgreSQL chooses a weak plan.
      // Distinct terms retain all-term matching across separate message chunks.
      const filters=`cardinality($9::text[])>=0 AND m.namespace=$1 AND m.tenant_hash=$2 AND m.id<=$3 AND(cardinality($4::text[])=0 OR m.topic=ANY($4)) AND(cardinality($5::text[])=0 OR m.agent=ANY($5) OR lower(m.name)=ANY(SELECT lower(regexp_replace(handle,'^@','')) FROM unnest($5::text[]) handle)) AND(cardinality($6::text[])=0 OR m.author=ANY($6)) AND($7::bigint IS NULL OR m.stamp>=$7) AND($8::bigint IS NULL OR m.stamp<=$8) ${args.after!==undefined?`AND m.id>${args.after}`:''} ${args.before!==undefined?`AND m.id<${args.before}`:''} ${args.thread!==undefined?`AND (m.id=${args.thread} OR (m.record->>'threadId')::bigint=${args.thread})`:''} ${args.rootsOnly?`AND NOT m.record ? 'threadId'`:''} ${args.query?`AND cardinality($9::text[])>0 AND m.id=ANY(ARRAY(SELECT message_id FROM matched))`:''}`;
      const ranking=args.query&&args.sort==='relevance'?`(SELECT coalesce(sum(ts_rank(c.words,plainto_tsquery('simple',$10))),0)::float8 FROM opencrawl_board_search_chunks c WHERE c.namespace=m.namespace AND c.tenant_hash=m.tenant_hash AND c.message_id=m.id)`:'0::float8';
      if(!cursor){snapshot.total=Number((await client.query(`${withMatches}SELECT count(*) total FROM opencrawl_board_messages m WHERE ${filters}`,values)).rows[0].total);snapshot.facets={};
        for(const field of new Set(args.facets)){const expression=field==='day'?"to_char(to_timestamp(m.stamp/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD')":'m.'+field;
          const rows=(await client.query(`${withMatches}SELECT ${expression} value,count(*) count${field==='agent'?',min(m.id) first_id':''} FROM opencrawl_board_messages m WHERE ${filters} GROUP BY ${expression} ORDER BY count(*) DESC,${expression} LIMIT $10`,[...values,args.facetSize])).rows;
          if(field==='agent')for(const row of rows)row.name=(await accessor(client,key).message(Number(row.first_id)))?.name;
          snapshot.facets[field]={values:rows.map(row=>({value:row.value,count:Number(row.count),...(field==='agent'?{name:row.name}:{})})),other:snapshot.total-rows.reduce((n,row)=>n+Number(row.count),0)};
        }
        await client.query('DELETE FROM opencrawl_board_search_snapshots WHERE namespace=$1 AND token IN(SELECT token FROM opencrawl_board_search_snapshots WHERE namespace=$1 AND expires<=$2 LIMIT 100)',[namespace,time]);
        await client.query('INSERT INTO opencrawl_board_search_snapshots VALUES($1,$2,$3,$4,$5,$6)',[namespace,token,key,owner,time+300000,snapshot]);
      }
      const ranked=await client.query<RankedMessage<Row>>(`WITH ${matching?matching+',':''}ranked AS(SELECT ${record} AS record,m.id,m.stamp,${ranking} rank FROM opencrawl_board_messages m WHERE ${filters}) SELECT * FROM ranked WHERE $10::text IS NOT NULL AND($11::float8 IS NULL OR(rank,stamp,id)${args.sort==='oldest'?'>':'<'}($11,$12::bigint,$13::bigint)) ORDER BY rank ${args.sort==='oldest'?'ASC':'DESC'},stamp ${args.sort==='oldest'?'ASC':'DESC'},id ${args.sort==='oldest'?'ASC':'DESC'} LIMIT $14`,[...values,args.query,boundary?.rank??null,boundary?.stamp??null,boundary?.id??null,args.limit]);
      const projected=await project(accessor(client,key),ranked.rows.map(row=>row.record));
      const messages:Output[]=[];const output={total:snapshot.total as number,through:snapshot.through as number,messages,...(!cursor&&Object.keys(snapshot.facets).length?{facets:snapshot.facets}:{}),next:null as string|null};
      let last:RankedMessage<Row>|undefined;for(const [index,row] of ranked.rows.entries()){messages.push(projected[index]);if(messages.length>1&&Buffer.byteLength(JSON.stringify(output))>8192){messages.pop();break;}last=row;}
      if(offset+messages.length<snapshot.total){if(!last)throw fail('Board search result set is incomplete');const next=offset+messages.length;await client.query('INSERT INTO opencrawl_board_search_pages VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[namespace,token,next,{rank:last.rank,stamp:Number(last.stamp),id:Number(last.id)}]);output.next=token+':'+next;}
      return output;
    });
  }
  return {watchDirect:(key:string)=>listen(wakeKey(namespace,key)),ready,read,transaction,search,searchAgentMessages,importLegacy,exportLegacy,readIn:exportIn,projectIn};
}

/** Validate before any DDL/import. Unknown fields fail instead of disappearing. */
const integer=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const messageFields={id:integer.min(1),timestamp:integer,agent:z.string(),author:z.string(),name:z.string(),topic:z.string(),text:z.string(),threadId:integer.min(1).optional(),replyTo:integer.min(1).optional(),mentionNames:z.array(z.string()).optional(),system:z.literal(true).optional()};
const publication=z.strictObject({explicitMentions:z.array(z.string()),unresolvedMentions:z.array(z.string())});
const messageSchema=z.strictObject({...messageFields,onlineAudience:z.array(z.string()).optional(),captureRef:z.string().optional(),requestId:z.string(),mentions:z.array(z.string()).optional(),publication:publication.optional()});
const deliverySchema=z.strictObject({receipt:z.string().regex(/^[a-f0-9]{64}$/),createdAt:integer,through:integer,more:z.boolean(),messages:z.array(z.strictObject({...messageFields,mentions:z.array(z.string()).optional(),reasons:z.array(z.string())}))});
const servedPageSchema=z.strictObject({readId:z.uuid(),after:integer,through:integer,first:integer.min(1),next:integer,proof:z.string().regex(/^[a-f0-9]{64}$/)});
const participantSchema=z.strictObject({userId:z.string().optional(),name:z.string(),task:z.string(),harness:z.string(),registeredAt:integer,seen:integer,left:z.boolean().optional(),topics:z.array(z.string()),followedThreads:z.array(integer.min(1)).optional(),mutedThreads:z.array(integer.min(1)).optional(),announced:z.boolean().optional(),captureRef:z.string().optional(),inboxAfter:integer.optional(),inboxLastReceipt:z.string().optional(),servedInbox:z.strictObject({direct:servedPageSchema.optional(),routine:servedPageSchema.optional()}).optional(),inboxPending:z.strictObject({ids:z.array(integer.min(1)).min(1).max(5),through:integer,cursor:z.string().regex(/^[a-f0-9]{64}$/)}).optional(),homepage:z.boolean().optional(),ackCursor:integer,lastPoll:integer.nullable(),lastAckAt:integer.nullable(),nextHomeAt:integer,pending:deliverySchema.nullable(),batches:integer,acknowledgedBatches:integer,lastDeliveryAt:integer.optional(),acknowledgedMessages:integer.optional(),lastReceipt:z.string().optional()});
const boardSchema=z.strictObject({schema:z.literal(1),messages:z.array(messageSchema),agents:z.record(z.string(),z.strictObject({name:z.string(),topics:z.array(z.string()),seen:integer})),usage:z.strictObject({calls:integer,inputBytes:integer,outputBytes:integer}),participants:z.record(z.string(),participantSchema).optional()});
export function validateLegacyBoard(value:unknown):asserts value is BoardState{
  const parsed=boardSchema.safeParse(value);if(!parsed.success)throw fail('Invalid or unsupported legacy board fields');
  const state=parsed.data;
  for(let index=0;index<state.messages.length;index++){
    const message=state.messages[index];
    if(message.id!==index+1)throw fail('Invalid legacy board message sequence');
    if(message.system&&(message.topic!==announcementChannel||message.threadId!==undefined||message.agent!==systemIdentity.agent||message.author!==systemIdentity.author||message.name!==systemIdentity.name))throw fail('Invalid board system identity');
    if(message.replyTo!==undefined){const parent=state.messages[message.replyTo-1];if(!parent||parent.id>=message.id||message.threadId===undefined||(parent.threadId??parent.id)!==message.threadId||parent.topic!==message.topic)throw fail('Invalid board reply target');}
    if(message.mentionNames!==undefined&&message.mentionNames.length!==(message.mentions??[]).length)throw fail('Invalid resolved board mentions');
    if(message.threadId!==undefined){const root=state.messages[message.threadId-1];if(message.threadId>=message.id||!root||root.threadId!==undefined||root.topic!==message.topic||message.topic===announcementChannel&&!root.system)throw fail('Invalid board thread root');}
  }
  for(const p of Object.values(state.participants??{})){
    for(const id of [...p.followedThreads??[],...p.mutedThreads??[]])if(!state.messages[id-1]||state.messages[id-1].threadId!==undefined)throw fail('Invalid followed board thread');
    if((p.followedThreads??[]).some(id=>p.mutedThreads?.includes(id)))throw fail('Conflicting board thread subscriptions');
    if(p.inboxAfter!==undefined&&p.inboxAfter>state.messages.length)throw fail('Invalid inbox cursor');
    if(p.inboxPending){let previous=p.inboxAfter??0;
      if(p.inboxPending.through>state.messages.length)throw fail('Invalid inbox pending boundary');
      for(const id of p.inboxPending.ids){if(id<=previous||id>p.inboxPending.through)throw fail('Invalid pending inbox IDs');previous=id;}
    }
    if(p.ackCursor>state.messages.length||p.acknowledgedBatches>p.batches)throw fail('Invalid legacy board participant cursor');
    if(p.pending){if(p.pending.through<p.ackCursor||p.pending.through>state.messages.length)throw fail('Invalid legacy board delivery cursor');let previous=p.ackCursor;
      for(const delivered of p.pending.messages){const {reasons,...body}=delivered,message=state.messages[body.id-1];if(!message||body.id<=previous||body.id>p.pending.through||!isDeepStrictEqual(body,visible(message)))throw fail('Legacy board delivery differs from its immutable publication');previous=body.id;}
    }
  }
}

/** Inventory includes every normalized relation; derived indexes are checked
 * against their existing owner producer, not promoted to source authority. */
export async function* inventoryBoardTargetsIn(database:ApplicationDatabase,client:PoolClient):AsyncGenerator<OnlineOwnedInventoryItem>{
 const ns=database.namespace,repo=createPostgresBoardState(database);
 if((await client.query('SELECT 1 FROM opencrawl_board_search_snapshots WHERE namespace=$1 UNION ALL SELECT 1 FROM opencrawl_board_search_pages WHERE namespace=$1 LIMIT 1',[ns])).rows.length)targetInventoryFailure('inactive shadow has runtime board search state');
 const tables=['heads','messages','search_chunks','topics','agents','participants','deliveries','delivery_messages'] as const;
 const owners=tables.map(name=>`SELECT tenant_hash FROM opencrawl_board_${name} WHERE namespace=$1`).join(' UNION ');
 for await(const row of scanTargetInventoryIn(client,`SELECT tenant_hash FROM (${owners}) owners ORDER BY tenant_hash COLLATE "C"`,[ns])){
  const key=String(row.tenant_hash);
  await assertTargetInventoryBoundIn(client,`SELECT coalesce(sum(bytes),0)::text bytes,count(*)::text rows FROM (${tables.map(name=>`SELECT octet_length(to_jsonb(t)::text) bytes FROM opencrawl_board_${name} t WHERE namespace=$1 AND tenant_hash=$2`).join(' UNION ALL ')}) bounded`,[ns,key]);
  const value=await repo.readIn(client,key);if(!value)targetInventoryFailure('board child has no parent');validateLegacyBoard(value);targetInventoryValueBytes(value,16*1024*1024);
  const head=(await client.query('SELECT head,participants_present FROM opencrawl_board_heads WHERE namespace=$1 AND tenant_hash=$2',[ns,key])).rows[0];if(head.head!==String(value.messages.length)||head.participants_present!==(value.participants!==undefined))targetInventoryFailure('board head differs');
  const topics=new Map<string,{first:number;posts:number;latest:{id:number;timestamp:number;name:string}}>();
  for await(const m of scanTargetInventoryIn(client,'SELECT id,stamp,agent,author,name,topic,request_id,legacy_agent,record FROM opencrawl_board_messages WHERE namespace=$1 AND tenant_hash=$2 ORDER BY id',[ns,key])){
   const message=value.messages[Number(m.id)-1];if(!message||!isDeepStrictEqual(m.record,message)||String(m.id)!==String(message.id)||String(m.stamp)!==String(message.timestamp)||m.agent!==message.agent||m.author!==message.author||m.name!==message.name||m.topic!==message.topic||m.request_id!==message.requestId||m.legacy_agent!==(message.agent===boardIdentity(message.author,message.name)))targetInventoryFailure('board message lookup differs');
   const prior=topics.get(message.topic);topics.set(message.topic,{first:prior?.first??message.id,posts:(prior?.posts??0)+1,latest:{id:message.id,timestamp:message.timestamp,name:message.name||message.agent}});
  }
  for(const batch of boardBatches(value.messages)){
   const inputs=batch.map(message=>({id:message.id,chunks:boardMessageChunks(message)}));
   const mismatch=(await client.query(`WITH input AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(id bigint,chunks jsonb)),
    expected AS (SELECT id,ordinal-1 AS ordinal,to_tsvector('simple',text) AS words FROM input CROSS JOIN LATERAL jsonb_array_elements_text(chunks) WITH ORDINALITY AS c(text,ordinal)),
    actual AS (SELECT message_id AS id,ordinal,words FROM opencrawl_board_search_chunks WHERE namespace=$1 AND tenant_hash=$2 AND message_id IN (SELECT id FROM input))
    SELECT 1 FROM expected FULL JOIN actual USING(id,ordinal) WHERE expected.words IS DISTINCT FROM actual.words LIMIT 1`,[ns,key,JSON.stringify(inputs)])).rows;
   if(mismatch.length)targetInventoryFailure('board derived search chunks differ');
  }
  // These joins are necessary even with normal foreign keys: malformed test or
  // restored schemas must not hide a row that owning export does not visit.
  const orphan=(await client.query(`SELECT 1 FROM opencrawl_board_search_chunks c WHERE c.namespace=$1 AND c.tenant_hash=$2 AND NOT EXISTS(SELECT 1 FROM opencrawl_board_messages m WHERE m.namespace=c.namespace AND m.tenant_hash=c.tenant_hash AND m.id=c.message_id)
   UNION ALL SELECT 1 FROM opencrawl_board_deliveries c WHERE c.namespace=$1 AND c.tenant_hash=$2 AND NOT EXISTS(SELECT 1 FROM opencrawl_board_participants p WHERE p.namespace=c.namespace AND p.tenant_hash=c.tenant_hash AND p.agent=c.agent)
   UNION ALL SELECT 1 FROM opencrawl_board_delivery_messages c WHERE c.namespace=$1 AND c.tenant_hash=$2 AND NOT EXISTS(SELECT 1 FROM opencrawl_board_deliveries p WHERE p.namespace=c.namespace AND p.tenant_hash=c.tenant_hash AND p.agent=c.agent) LIMIT 1`,[ns,key])).rows;
  if(orphan.length)targetInventoryFailure('board orphan child');
  for await(const t of scanTargetInventoryIn(client,'SELECT topic,first_id,posts,latest FROM opencrawl_board_topics WHERE namespace=$1 AND tenant_hash=$2 ORDER BY topic COLLATE "C"',[ns,key])){const expected=topics.get(String(t.topic));if(!expected||String(t.first_id)!==String(expected.first)||String(t.posts)!==String(expected.posts)||!isDeepStrictEqual(t.latest,expected.latest))targetInventoryFailure('board derived topic differs');topics.delete(String(t.topic));}if(topics.size)targetInventoryFailure('board derived topic missing');
  let position=0;for await(const a of scanTargetInventoryIn(client,'SELECT agent,position,record FROM opencrawl_board_agents WHERE namespace=$1 AND tenant_hash=$2 ORDER BY position,agent COLLATE "C"',[ns,key])){position++;if(String(a.position)!==String(position)||!isDeepStrictEqual(a.record,value.agents[String(a.agent)]))targetInventoryFailure('board agent differs');}
  for await(const p of scanTargetInventoryIn(client,'SELECT agent,user_id,name,seen,record FROM opencrawl_board_participants WHERE namespace=$1 AND tenant_hash=$2 ORDER BY agent COLLATE "C"',[ns,key])){const participant=value.participants?.[String(p.agent)];if(!participant||p.user_id!==(participant.userId??null)||p.name!==participant.name||String(p.seen)!==String(participant.seen))targetInventoryFailure('board participant lookup differs');
   const delivery=(await client.query('SELECT receipt FROM opencrawl_board_deliveries WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3',[ns,key,p.agent])).rows[0];if(delivery&&delivery.receipt!==participant.pending?.receipt)targetInventoryFailure('board delivery receipt differs');
   let ordinal=0;for await(const d of scanTargetInventoryIn(client,'SELECT ordinal FROM opencrawl_board_delivery_messages WHERE namespace=$1 AND tenant_hash=$2 AND agent=$3 ORDER BY ordinal',[ns,key,p.agent]))if(d.ordinal!==ordinal++)targetInventoryFailure('board delivery ordering differs');
  }
  yield {kind:'target',domains:['board'],identity:[key],value,maxBytes:16*1024*1024};
 }
}
