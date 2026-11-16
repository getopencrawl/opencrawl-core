import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ONLINE_MAX_PAYLOAD_BYTES,type OnlineExternalSnapshot,type OnlineExternalStore,type OnlineIntent,type createOnlineJournal} from './online-journal.mjs';
import {onlineMigrationBindingId} from './online-temporal/binding.mjs';
import type {OnlineMigrationAdapter,OnlineMigrationBinding} from './online-temporal/types.mjs';
type Journal=ReturnType<typeof createOnlineJournal>;
export interface OnlineShadowListing {listPage(input:{prefix:string;cursor:string|null;limit:number;signal:AbortSignal}):Promise<{keys:string[];cursor:string|null}>}
export type OnlineShadowClassifier=(key:string)=>{maxBytes:number}|null;
type SourceCursor={stage:'source';root:number;token:string|null;last:string|null};
type Cursor=SourceCursor|{stage:'shadow';after:string};
interface Mirror {deleted:boolean;bytes:Buffer|null;contentType:string|null;hash:string|null;revision:string;operationId:string|null;sequence:string;sourceVersion:string|null}
function unsafe():never{throw Object.assign(Error('Online shadow scope, capability or parity is invalid'),{code:'ONLINE_MIGRATION_UNSAFE'});}
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&!value.includes('\0')&&Buffer.byteLength(value)<=max;
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const ordered=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
/** A migration mirror only. It neither implements ApplicationState nor marks an
 * installation ready. The caller supplies reviewed roots/classification and a
 * trusted live source/target check; Workflow callers cannot choose them. */
export function createOnlineShadow({database,binding:input,journal,external,listing,roots:inputRoots,classify,assertCurrent}:{database:{pool:Pool;namespace:string};binding:OnlineMigrationBinding;journal:Journal;external:OnlineExternalStore;listing:OnlineShadowListing;roots:readonly string[];classify:OnlineShadowClassifier;assertCurrent:(signal:AbortSignal)=>Promise<void>}){
 const binding=Object.freeze({...input}),bindingId=onlineMigrationBindingId(binding);const namespace=database.namespace,roots=Object.freeze([...inputRoots]),scope=[namespace,binding.epoch,binding.sourceId];
 if(!text(namespace,2048)||roots.length<1||roots.length>32||roots.some(root=>!text(root,4096))||roots.some((root,i)=>roots.some((other,j)=>i!==j&&(root.startsWith(other)||other.startsWith(root)))))unsafe();
 if(!journal.binding||journal.binding.namespace!==namespace||journal.binding.epoch!==binding.epoch||journal.binding.sourceId!==binding.sourceId)unsafe();
 let preparing:Promise<void>|undefined;
 function bound(key:string){if(!text(key,8192)||!roots.some(root=>key.startsWith(root)))unsafe();const value=classify(key);if(value===null)return null;if(!value||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<1||value.maxBytes>ONLINE_MAX_PAYLOAD_BYTES)unsafe();return value;}
 function shard(key:string){return createHash('sha256').update(key).digest().readUInt32BE(0)%binding.shards;}
 function pageInput(input:{shard:number;shards:number;limit:number;signal:AbortSignal}){if(input.shards!==binding.shards||!Number.isSafeInteger(input.shard)||input.shard<0||input.shard>=binding.shards||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>64)unsafe();input.signal.throwIfAborted();}
 function parseCursor(value:string|null):Cursor{
  if(value===null)return {stage:'source',root:0,token:null,last:null};if(!text(value,8192))unsafe();let parsed:Cursor;try{parsed=JSON.parse(value);}catch{return unsafe();}
  if(!parsed||typeof parsed!=='object')unsafe();
  if(parsed.stage==='shadow'){if(Object.keys(parsed).sort().join(',')!=='after,stage'||typeof parsed.after!=='string'||Buffer.byteLength(parsed.after)>8192)unsafe();}
  else if(parsed.stage==='source'){if(Object.keys(parsed).sort().join(',')!=='last,root,stage,token'||!Number.isInteger(parsed.root)||parsed.root<0||parsed.root>=roots.length||parsed.token!==null&&!text(parsed.token,8192)||parsed.last!==null&&!text(parsed.last,8192))unsafe();}
  else unsafe();return parsed;
 }
 function encodeCursor(value:Cursor|null){if(value===null)return null;const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>8192)unsafe();return encoded;}
 async function ready(){preparing??=(async()=>{
  await journal.ready();const client=await database.pool.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-shadow:schema',0))");
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_shadow_objects(
    namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,target_id text NOT NULL,
    logical_deleted boolean NOT NULL,payload bytea,payload_hash text,content_type text,revision bigint NOT NULL CHECK(revision>=0),operation_id uuid,
    source_sequence bigint NOT NULL CHECK(source_sequence>=0),source_version text,
    PRIMARY KEY(namespace,epoch,source_id,source_key),
    CHECK((logical_deleted AND payload IS NULL AND payload_hash IS NULL AND content_type IS NULL) OR (NOT logical_deleted AND payload IS NOT NULL AND octet_length(payload)<=${ONLINE_MAX_PAYLOAD_BYTES} AND payload_hash IS NOT NULL AND payload_hash~'^[a-f0-9]{64}$' AND content_type IS NOT NULL)),
    CHECK((revision=0 AND operation_id IS NULL AND source_sequence=0) OR (revision>0 AND operation_id IS NOT NULL AND source_sequence>0 AND source_version IS NOT NULL)))`);await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 })().catch(error=>{preparing=undefined;throw error;});await preparing;}
 function snapshot(value:OnlineExternalSnapshot,maxBytes:number):OnlineExternalSnapshot{
  if(!value||typeof value.deleted!=='boolean'||value.version!==null&&!text(value.version,2048)||value.operationId!==null&&!uuid(value.operationId)||value.revision!==null&&(!decimal(value.revision)||value.revision==='0'))unsafe();
  if(value.version===null&&(!value.deleted||value.operationId!==null||value.revision!==null)||value.operationId===null&&value.revision!==null||value.operationId!==null&&value.revision===null)unsafe();
  if(value.deleted){if(value.bytes!==null||value.contentType!==null||value.version!==null&&value.operationId===null)unsafe();}
  else if(value.version===null||!Buffer.isBuffer(value.bytes)||value.bytes.length>maxBytes||!text(value.contentType,256)||/[\r\n]/.test(value.contentType))unsafe();
  return {...value,bytes:value.bytes===null?null:Buffer.from(value.bytes)};
 }
 async function read(client:Pick<PoolClient,'query'>,key:string):Promise<Mirror|null>{
  const row=(await client.query('SELECT target_id,logical_deleted,payload,payload_hash,content_type,revision::text,operation_id::text,source_sequence::text,source_version FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,key])).rows[0];
  if(!row)return null;const cap=bound(key);if(!cap||row.target_id!==binding.targetId||!decimal(row.revision)||!decimal(row.source_sequence)||typeof row.logical_deleted!=='boolean'||row.source_version!==null&&!text(row.source_version,2048))unsafe();
  if(row.revision==='0'?row.operation_id!==null||row.source_sequence!=='0':!uuid(row.operation_id)||row.source_sequence==='0'||row.source_version===null)unsafe();
  if(row.logical_deleted){if(row.payload!==null||row.payload_hash!==null||row.content_type!==null)unsafe();}
  else if(!Buffer.isBuffer(row.payload)||row.payload.length>cap.maxBytes||row.payload_hash!==hash(row.payload)||!text(row.content_type,256)||/[\r\n]/.test(row.content_type))unsafe();
  return {deleted:row.logical_deleted,bytes:row.payload,hash:row.payload_hash,contentType:row.content_type,revision:row.revision,operationId:row.operation_id,sequence:row.source_sequence,sourceVersion:row.source_version};
 }
 const equal=(a:Mirror,b:Mirror)=>a.deleted===b.deleted&&a.hash===b.hash&&a.contentType===b.contentType&&a.revision===b.revision&&a.operationId===b.operationId&&a.sequence===b.sequence&&a.sourceVersion===b.sourceVersion&&(a.bytes===null?b.bytes===null:b.bytes!==null&&a.bytes.equals(b.bytes));
 const values=(key:string,value:Mirror)=>[...scope,key,binding.targetId,value.deleted,value.bytes,value.hash,value.contentType,value.revision,value.operationId,value.sequence,value.sourceVersion];
 async function insert(client:PoolClient,key:string,value:Mirror){await client.query('INSERT INTO opencrawl_online_shadow_objects(namespace,epoch,source_id,source_key,target_id,logical_deleted,payload,payload_hash,content_type,revision,operation_id,source_sequence,source_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING',values(key,value));}
 async function backfill(key:string){const cap=bound(key);if(!cap)return {applied:false};return journal.backfillIfUnchanged({key,apply:async client=>{
  const observed=snapshot(await external.read(key,{maxBytes:cap.maxBytes}),cap.maxBytes);
  // A stamp without this epoch's journal history needs explicit recovery; it
  // cannot silently become a revision-zero baseline for a new installation.
  if(observed.operationId!==null||observed.revision!==null)unsafe();
  const expected:Mirror={deleted:observed.deleted,bytes:observed.bytes,contentType:observed.contentType,hash:observed.bytes===null?null:hash(observed.bytes),revision:'0',operationId:null,sequence:'0',sourceVersion:observed.version};
  await insert(client,key,expected);const actual=await read(client,key);if(!actual||!equal(actual,expected))unsafe();
 }});}
 async function applyJournal(client:PoolClient,intent:OnlineIntent){
  if(!intent||intent.namespace!==namespace||intent.epoch!==binding.epoch||intent.sourceId!==binding.sourceId||intent.state!=='applied'||!uuid(intent.operationId)||!decimal(intent.revision)||intent.revision==='0'||!decimal(intent.sequence)||intent.sequence==='0'||!text(intent.resultVersion,2048))unsafe();
  const cap=bound(intent.key);if(!cap)return false;
  const mutation=intent.mutation;if(mutation.kind!=='put'&&mutation.kind!=='delete')unsafe();
  if(mutation.kind==='put'&&(!Buffer.isBuffer(mutation.bytes)||mutation.bytes.length>cap.maxBytes||!text(mutation.contentType,256)||/[\r\n]/.test(mutation.contentType)))unsafe();
  const bytes=mutation.kind==='put'?Buffer.from(mutation.bytes):null;
  const expected:Mirror={deleted:mutation.kind==='delete',bytes,hash:bytes===null?null:hash(bytes),contentType:mutation.kind==='put'?mutation.contentType:null,revision:intent.revision,operationId:intent.operationId,sequence:intent.sequence,sourceVersion:intent.resultVersion};
  const prior=await read(client,intent.key);
  if(prior){if(BigInt(prior.revision)>BigInt(expected.revision)||prior.revision===expected.revision&&!equal(prior,expected)||BigInt(prior.sequence)>BigInt(expected.sequence))unsafe();if(equal(prior,expected))return true;}
  await insert(client,intent.key,expected);
  if(prior){const changed=await client.query('UPDATE opencrawl_online_shadow_objects SET logical_deleted=$6,payload=$7,payload_hash=$8,content_type=$9,revision=$10,operation_id=$11,source_sequence=$12,source_version=$13 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND target_id=$5 AND revision=$14', [...values(intent.key,expected),prior.revision]);if(changed.rowCount!==1)unsafe();}
  const actual=await read(client,intent.key);if(!actual||!equal(actual,expected))unsafe();return true;
 }
 async function sourcePage(position:SourceCursor,limit:number,signal:AbortSignal){
  let current=position;
  for(let attempts=0;attempts<roots.length;attempts++){
   signal.throwIfAborted();const page=await listing.listPage({prefix:roots[current.root]!,cursor:current.token,limit,signal});
   if(!page||!Array.isArray(page.keys)||page.keys.length>limit||page.cursor!==null&&!text(page.cursor,8192)||page.cursor!==null&&page.cursor===current.token)unsafe();
   for(let i=0;i<page.keys.length;i++){const key=page.keys[i]!;if(!text(key,8192)||!key.startsWith(roots[current.root]!)||(i?ordered(page.keys[i-1]!,key)>=0:current.last!==null&&ordered(current.last,key)>=0))unsafe();}
   if(page.keys.length===0&&page.cursor!==null)unsafe();
   const next:SourceCursor|null=page.cursor!==null?{...current,token:page.cursor,last:page.keys.at(-1)!}:current.root+1<roots.length?{stage:'source',root:current.root+1,token:null,last:null}:null;
   if(page.keys.length||next===null)return {keys:page.keys,next};current=next;
  }return unsafe();
 }
 async function drift(through:string){if(!decimal(through))unsafe();const frontier=await journal.frontierState();return frontier.pending||frontier.allocated!==through||frontier.closed!==through;}
 async function compare(key:string,through:string){
  const cap=bound(key);if(!cap)return {drift:false,mismatch:false};
  const observation=await journal.observeKey({key,through,read:async client=>{
   const actual=await read(client,key),observed=snapshot(await external.read(key,{maxBytes:cap.maxBytes}),cap.maxBytes);
   if(!actual||BigInt(actual.sequence)>BigInt(through))return false;
   return actual.deleted===observed.deleted&&actual.contentType===observed.contentType&&actual.sourceVersion===observed.version&&actual.operationId===observed.operationId&&(actual.revision==='0'?observed.revision===null:actual.revision===observed.revision)&&(actual.bytes===null?observed.bytes===null:observed.bytes!==null&&actual.bytes.equals(observed.bytes));
  }});return observation.observed?{drift:false,mismatch:!observation.value}:{drift:true,mismatch:false};
 }
 const adapter:OnlineMigrationAdapter={
  async assertCurrent(signal){await ready();signal.throwIfAborted();await assertCurrent(signal);},
  frontierState:()=>journal.frontierState(),
  async reconcilePending(input){
   if(input.cursor!==null&&!decimal(input.cursor)||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>8)unsafe();
   input.signal.throwIfAborted();const started=performance.now(),page=await journal.pendingPage({...(input.cursor===null?{}:{after:input.cursor}),limit:input.limit});
   let processed=0,pending=0,settled=0,after=input.cursor,exhausted=false;
   for(const entry of page.entries){
    if(processed&&performance.now()-started>=30000){exhausted=true;break;}input.signal.throwIfAborted();
    try{await journal.reconcile(entry.key,external);settled++;}
    catch(error){if(error&&typeof error==='object'&&'code' in error&&['ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN','ONLINE_MIGRATION_UNRESOLVED_INTENT'].includes(String(error.code)))pending++;else throw error;}
    processed++;after=entry.sequence;
   }
   return {cursor:exhausted?after:page.next,processed,pending,settled,budgetExhausted:exhausted||performance.now()-started>=30000};
  },
  async backfillPage(input){pageInput(input);const position=parseCursor(input.cursor);if(position.stage!=='source')unsafe();const page=await sourcePage(position,input.limit,input.signal);
   for(const key of page.keys){input.signal.throwIfAborted();if(bound(key)&&shard(key)===input.shard)await backfill(key);}return {cursor:encodeCursor(page.next),processed:page.keys.length};},
  closedFrontier:()=>journal.closedFrontier(),
  async replayPage(input){pageInput(input);if(input.consumer!==bindingId+'-'+input.shard)unsafe();const result=await journal.replayPage({consumer:input.consumer,through:input.through,limit:input.limit,apply:async(client,intent)=>{input.signal.throwIfAborted();if(bound(intent.key)&&shard(intent.key)===input.shard)await applyJournal(client,intent);}});return {checkpoint:result.checkpoint,processed:result.applied+result.notApplied,blocked:result.pending};},
  async parityPage(input){pageInput(input);if(await journal.replayCheckpoint(bindingId+'-'+input.shard)!==input.through)unsafe();if(await drift(input.through))return {cursor:null,processed:0,mismatches:0,drift:true};let position=parseCursor(input.cursor),keys:string[],next:Cursor|null;
   if(position.stage==='source'){
    const page=await sourcePage(position,input.limit,input.signal);keys=page.keys;next=page.next??{stage:'shadow',after:''};
    if(keys.length===0)position={stage:'shadow',after:''};
   }else{keys=[];next=null;}
   if(position.stage==='shadow'){
    keys=(await database.pool.query('SELECT source_key FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key COLLATE "C">$4 ORDER BY source_key COLLATE "C" LIMIT $5',[...scope,position.after,input.limit])).rows.map(row=>row.source_key);
    next=keys.length===input.limit?{stage:'shadow',after:keys.at(-1)!}:null;
   }
   let mismatches=0,changed=false;for(const key of keys!){input.signal.throwIfAborted();if(bound(key)&&shard(key)===input.shard){const result=await compare(key,input.through);if(result.mismatch)mismatches++;changed ||= result.drift;}}
   changed ||= await drift(input.through);return {cursor:encodeCursor(next!),processed:keys!.length,mismatches,drift:changed};
  },
 };
 return {ready,backfill,applyJournal,adapter};
}
