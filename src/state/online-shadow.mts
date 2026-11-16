import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {createOnlineCoverage,type OnlineCoveragePolicy,type OnlineCoverageTarget,type OnlineCoverageEntry,type OnlineCoverageEvidence} from './online-coverage.mjs';
import {ONLINE_MAX_PAYLOAD_BYTES,type OnlineExternalSnapshot,type OnlineExternalStore,type OnlineIntent,type OnlineSourceRegistration,type createOnlineJournal} from './online-journal.mjs';
import {onlineMigrationBindingId} from './online-temporal/binding.mjs';
import type {OnlineMigrationAdapter,OnlineMigrationBinding} from './online-temporal/types.mjs';
type Journal=ReturnType<typeof createOnlineJournal>;
export interface OnlineShadowListing {listPage(input:{prefix:string;cursor:string|null;limit:number;signal:AbortSignal}):Promise<{keys:string[];cursor:string|null}>}
export type OnlineShadowSelection={kind:'retained';domain:string;maxBytes:number}|{kind:'retired';domain:string;maxBytes:number;scopeHash:string}|{kind:'preserved-native';domain:'event-identities';maxBytes:number;nativeBindingHash:string}|{kind:'immutable'};
/** Implemented by the typed coordinator. It is a transaction participant, not
 * a runtime store or an admission callback. */
export interface OnlineShadowParticipant {
 binding:Readonly<{namespace:string;epoch:string;sourceId:string;targetId:string;identity:string}>;
 select(key:string):OnlineShadowSelection;
 ready():Promise<void>;
 backfillIn(client:PoolClient,key:string,snapshot:OnlineExternalSnapshot):Promise<OnlineCoverageTarget>;
 backfillRetiredIn(client:PoolClient,key:string,selection:Extract<OnlineShadowSelection,{kind:'retired'}>):Promise<OnlineCoverageTarget>;
 applyIn(client:PoolClient,intent:OnlineIntent,selection:Exclude<OnlineShadowSelection,{kind:'immutable'|'preserved-native'}>):Promise<OnlineCoverageTarget>;
 inspectIn(client:PoolClient,key:string,snapshot:OnlineExternalSnapshot):Promise<boolean>;
 inspectRetiredIn(client:PoolClient,key:string,selection:Extract<OnlineShadowSelection,{kind:'retired'}>):Promise<boolean>;
 inspectNativeIn?(client:PoolClient,key:string,selection:Extract<OnlineShadowSelection,{kind:'preserved-native'}>):Promise<{nativeBindingHash:string}>;
 keysPageIn(client:PoolClient,input:{after:string;limit:number}):Promise<string[]>;
}
export type OnlineShadowClassifier=(key:string)=>{maxBytes:number;preservedNative?:true}|null;
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
export function createOnlineShadow({database,binding:input,journal,external,listing,roots:inputRoots,classify,assertCurrent,participant,coveragePolicy,sourceRegistration:inputRegistration}:{database:{pool:Pool;namespace:string};binding:OnlineMigrationBinding;journal:Journal;external:OnlineExternalStore;listing:OnlineShadowListing;roots:readonly string[];classify:OnlineShadowClassifier;assertCurrent:(signal:AbortSignal)=>Promise<void>;participant?:OnlineShadowParticipant;coveragePolicy?:OnlineCoveragePolicy;sourceRegistration?:OnlineSourceRegistration}){
 const binding=Object.freeze({...input}),bindingId=onlineMigrationBindingId(binding);const namespace=database.namespace,roots=Object.freeze([...inputRoots]),scope=[namespace,binding.epoch,binding.sourceId];
 if(!text(namespace,2048)||roots.length<1||roots.length>32||roots.some(root=>!text(root,4096))||roots.some((root,i)=>roots.some((other,j)=>i!==j&&(root.startsWith(other)||other.startsWith(root)))))unsafe();
 if(!journal.binding||journal.binding.namespace!==namespace||journal.binding.epoch!==binding.epoch||journal.binding.sourceId!==binding.sourceId)unsafe();
 if(participant&&(!participant.binding||participant.binding.namespace!==namespace||participant.binding.epoch!==binding.epoch||participant.binding.sourceId!==binding.sourceId||participant.binding.targetId!==binding.targetId||!/^[a-f0-9]{64}$/.test(participant.binding.identity)))unsafe();
 const sourceRegistration=inputRegistration?Object.freeze({...inputRegistration}):undefined;
 if(sourceRegistration&&(!/^[a-f0-9]{64}$/.test(sourceRegistration.bindingHash)||!/^[a-f0-9]{64}$/.test(sourceRegistration.enrollmentReceiptHash)||Object.keys(sourceRegistration).sort().join(',')!=='bindingHash,enrollmentReceiptHash'))unsafe();
 const baseIdentity=hash(JSON.stringify([bindingId,roots,participant?.binding.identity??'byte-mirror-only-v1',sourceRegistration??null]));
 if(coveragePolicy&&!participant)unsafe();
 const coverage=coveragePolicy?createOnlineCoverage({database,epoch:binding.epoch,sourceId:binding.sourceId,targetId:binding.targetId,shards:binding.shards,roots,participantIdentity:baseIdentity,policy:coveragePolicy}):undefined;
 const participantIdentity=coverage?hash(JSON.stringify([baseIdentity,coverage.identity])):baseIdentity;
 let preparing:Promise<void>|undefined;
 function bound(key:string){if(!text(key,8192)||!roots.some(root=>key.startsWith(root)))unsafe();const value=classify(key);if(value===null)return null;if(!value||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<1||value.maxBytes>ONLINE_MAX_PAYLOAD_BYTES||value.preservedNative!==undefined&&value.preservedNative!==true)unsafe();return value;}
 function selected(key:string):OnlineShadowSelection{
  const cap=bound(key);if(!participant){if(cap?.preservedNative)unsafe();return cap?{kind:'retained',domain:'byte-mirror',maxBytes:cap.maxBytes}:{kind:'immutable'};}
  const choice=participant.select(key);if(!choice||!['retained','retired','immutable','preserved-native'].includes(choice.kind))unsafe();
  if(choice.kind==='immutable'){if(cap!==null)unsafe();return choice;}
  if(!cap||!text(choice.domain,200)||choice.maxBytes!==cap.maxBytes||choice.kind==='retired'&&!/^[a-f0-9]{64}$/.test(choice.scopeHash))unsafe();if((choice.kind==='preserved-native')!==(cap.preservedNative===true))unsafe();if(choice.kind==='preserved-native'&&(!coverage||!participant.inspectNativeIn||choice.domain!=='event-identities'||!/^[a-f0-9]{64}$/.test(choice.nativeBindingHash)))unsafe();return {...choice};
 }
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
  if(sourceRegistration)await journal.attachSource(sourceRegistration);else await journal.ready();await participant?.ready();await coverage?.ready();const client=await database.pool.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-shadow:schema',0))");
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_shadow_objects(
    namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,target_id text NOT NULL,
    logical_deleted boolean NOT NULL,payload bytea,payload_hash text,content_type text,revision bigint NOT NULL CHECK(revision>=0),operation_id uuid,
    source_sequence bigint NOT NULL CHECK(source_sequence>=0),source_version text,
    PRIMARY KEY(namespace,epoch,source_id,source_key),
    CHECK((logical_deleted AND payload IS NULL AND payload_hash IS NULL AND content_type IS NULL) OR (NOT logical_deleted AND payload IS NOT NULL AND octet_length(payload)<=${ONLINE_MAX_PAYLOAD_BYTES} AND payload_hash IS NOT NULL AND payload_hash~'^[a-f0-9]{64}$' AND content_type IS NOT NULL)),
    CHECK((revision=0 AND operation_id IS NULL AND source_sequence=0) OR (revision>0 AND operation_id IS NOT NULL AND source_sequence>0 AND source_version IS NOT NULL)))`);
   await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_shadow_bindings(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,target_id text NOT NULL,participant_identity text NOT NULL CHECK(participant_identity~'^[a-f0-9]{64}$'),PRIMARY KEY(namespace,epoch,source_id));
    CREATE TABLE IF NOT EXISTS opencrawl_online_shadow_seen_retirements(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,participant_identity text NOT NULL CHECK(participant_identity~'^[a-f0-9]{64}$'),pass_id uuid NOT NULL,through_sequence bigint NOT NULL CHECK(through_sequence>=0),PRIMARY KEY(namespace,epoch,source_id,source_key))`);
   const prior=(await client.query('SELECT target_id,participant_identity FROM opencrawl_online_shadow_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];
   if(!prior){if((await client.query('SELECT 1 FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND epoch=$2 AND source_id=$3 LIMIT 1',scope)).rows.length)unsafe();
    await client.query('INSERT INTO opencrawl_online_shadow_bindings VALUES($1,$2,$3,$4,$5)',[...scope,binding.targetId,participantIdentity]);
   }else if(prior.target_id!==binding.targetId||prior.participant_identity!==participantIdentity)unsafe();
   await client.query('COMMIT');
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
 function coverageEntry(key:string,choice:OnlineShadowSelection):OnlineCoverageEntry{return {key,kind:choice.kind,domain:choice.kind==='immutable'?null:choice.domain,scopeHash:choice.kind==='retired'?choice.scopeHash:null,...(choice.kind==='preserved-native'?{nativeBindingHash:choice.nativeBindingHash}:{})};}
 async function certifyIn(client:PoolClient,key:string,choice:Exclude<OnlineShadowSelection,{kind:'immutable'}>,source:Pick<OnlineCoverageEvidence,'revision'|'sequence'|'operationId'|'sourceVersion'|'sourceHash'|'sourceBytes'|'deleted'|'absent'>,target?:OnlineCoverageTarget){
  if(!coverage)return;await coverage.recordIn(client,{...coverageEntry(key,choice),...source,targetKey:target?.targetKey??null,targetHash:target?.targetHash??null});
 }
 async function backfill(key:string){const choice=selected(key);if(choice.kind==='immutable')return {applied:false};const result=await journal.backfillIfUnchanged({key,apply:async client=>{
  if(choice.kind==='preserved-native'){const proof=await participant!.inspectNativeIn!(client,key,choice);if(proof.nativeBindingHash!==choice.nativeBindingHash)unsafe();await certifyIn(client,key,choice,{revision:'0',sequence:'0',operationId:null,sourceVersion:null,sourceHash:null,sourceBytes:null,deleted:false,absent:false});return;}
  if(choice.kind==='retired'){const target=await participant!.backfillRetiredIn(client,key,choice);await certifyIn(client,key,choice,{revision:'0',sequence:'0',operationId:null,sourceVersion:null,sourceHash:null,sourceBytes:null,deleted:false,absent:false},target);return;}
  const observed=snapshot(await external.read(key,{maxBytes:choice.maxBytes}),choice.maxBytes);
  if(observed.operationId!==null||observed.revision!==null)unsafe();
  // A stale listing may outlive a pre-enrollment physical delete. Absence has
  // no authority to clear an existing mirror or typed target.
  if(observed.version===null){if(await read(client,key))unsafe();await certifyIn(client,key,choice,{revision:'0',sequence:'0',operationId:null,sourceVersion:null,sourceHash:null,sourceBytes:null,deleted:true,absent:true});return;}
  const expected:Mirror={deleted:observed.deleted,bytes:observed.bytes,contentType:observed.contentType,hash:observed.bytes===null?null:hash(observed.bytes),revision:'0',operationId:null,sequence:'0',sourceVersion:observed.version};
  await insert(client,key,expected);const actual=await read(client,key);if(!actual||!equal(actual,expected))unsafe();
  const target=await participant?.backfillIn(client,key,observed);await certifyIn(client,key,choice,{revision:'0',sequence:'0',operationId:null,sourceVersion:observed.version,sourceHash:expected.hash,sourceBytes:observed.bytes?.length??null,deleted:observed.deleted,absent:false},target);
 }});if(choice.kind==='preserved-native'&&!result.applied)unsafe();return result;}
 async function applyJournal(client:PoolClient,intent:OnlineIntent){
  if(!intent||intent.namespace!==namespace||intent.epoch!==binding.epoch||intent.sourceId!==binding.sourceId||intent.state!=='applied'||!uuid(intent.operationId)||!decimal(intent.revision)||intent.revision==='0'||!decimal(intent.sequence)||intent.sequence==='0'||!text(intent.resultVersion,2048))unsafe();
  const choice=selected(intent.key);if(choice.kind==='preserved-native')unsafe();if(choice.kind==='immutable'){if(participant)unsafe();return false;}const cap=choice;
  const mutation=intent.mutation;if(mutation.kind!=='put'&&mutation.kind!=='delete')unsafe();
  if(mutation.kind==='put'&&(!Buffer.isBuffer(mutation.bytes)||mutation.bytes.length>cap.maxBytes||!text(mutation.contentType,256)||/[\r\n]/.test(mutation.contentType)))unsafe();
  intent={...intent,mutation:mutation.kind==='put'?{...mutation,bytes:Buffer.from(mutation.bytes)}:{kind:'delete'}};
  const certify=async(target?:OnlineCoverageTarget)=>certifyIn(client,intent.key,choice,{revision:intent.revision,sequence:intent.sequence,operationId:intent.operationId,sourceVersion:intent.resultVersion,sourceHash:intent.mutation.kind==='put'?hash(intent.mutation.bytes):null,sourceBytes:intent.mutation.kind==='put'?intent.mutation.bytes.length:null,deleted:intent.mutation.kind==='delete',absent:false},target);
  if(choice.kind==='retired'){await certify(await participant!.applyIn(client,intent,choice));return true;}
  const bytes=mutation.kind==='put'?Buffer.from(mutation.bytes):null;
  const expected:Mirror={deleted:mutation.kind==='delete',bytes,hash:bytes===null?null:hash(bytes),contentType:mutation.kind==='put'?mutation.contentType:null,revision:intent.revision,operationId:intent.operationId,sequence:intent.sequence,sourceVersion:intent.resultVersion};
  const prior=await read(client,intent.key);
  if(prior){if(BigInt(prior.revision)>BigInt(expected.revision)||prior.revision===expected.revision&&!equal(prior,expected)||BigInt(prior.sequence)>BigInt(expected.sequence))unsafe();if(equal(prior,expected)){await certify(await participant?.applyIn(client,intent,choice));return true;}}
  await insert(client,intent.key,expected);
  if(prior){const changed=await client.query('UPDATE opencrawl_online_shadow_objects SET logical_deleted=$6,payload=$7,payload_hash=$8,content_type=$9,revision=$10,operation_id=$11,source_sequence=$12,source_version=$13 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND target_id=$5 AND revision=$14', [...values(intent.key,expected),prior.revision]);if(changed.rowCount!==1)unsafe();}
  const actual=await read(client,intent.key);if(!actual||!equal(actual,expected))unsafe();await certify(await participant?.applyIn(client,intent,choice));return true;
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
 function parityPosition(value:string|null,through:string,shard:number){
  if(!participant)return {position:parseCursor(value),passId:null};
  if(value===null)return {position:parseCursor(null),passId:randomUUID()};
  if(!text(value,8192))unsafe();let parsed;try{parsed=JSON.parse(value);}catch{return unsafe();}
  if(!parsed||Object.keys(parsed).sort().join(',')!=='bindingId,identity,passId,position,shard,through'||parsed.bindingId!==bindingId||parsed.identity!==participantIdentity||parsed.through!==through||parsed.shard!==shard||!uuid(parsed.passId))unsafe();
  return {position:parseCursor(JSON.stringify(parsed.position)),passId:parsed.passId as string};
 }
 function parityCursor(position:Cursor|null,through:string,shard:number,passId:string|null){
  if(!participant||position===null)return encodeCursor(position);const value=JSON.stringify({bindingId,identity:participantIdentity,passId,through,shard,position});if(!text(value,8192))unsafe();return value;
 }
 async function targetKeys(after:string,limit:number){
  const client=await database.pool.connect();let failed=false;try{
   const mirror=(await client.query('SELECT source_key FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key>$4 COLLATE "C" ORDER BY source_key COLLATE "C" LIMIT $5',[...scope,after,limit])).rows.map(row=>row.source_key as string);
   const additional=participant?await participant.keysPageIn(client,{after,limit}):[];
   const native=coverage?await coverage.nativeKeysPageIn(client,{after,limit}):[];
   const seen=participant?(await client.query('SELECT source_key FROM opencrawl_online_shadow_seen_retirements WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key>$4 COLLATE "C" ORDER BY source_key COLLATE "C" LIMIT $5',[...scope,after,limit])).rows.map(row=>row.source_key as string):[];
   for(const keys of [mirror,additional,seen,native])if(keys.length>limit||keys.some((key,i)=>!text(key,8192)||ordered(key,i?keys[i-1]!:after)<=0))unsafe();
   return [...new Set([...mirror,...additional,...seen,...native])].sort(ordered).slice(0,limit);
  }catch(error){failed=true;throw error;}finally{client.release(failed);}
 }
 async function compare(key:string,through:string,passId:string|null,fromSource:boolean){
  const choice=selected(key);if(choice.kind==='immutable')return {drift:false,mismatch:false};
  const observation=await journal.observeKey({key,through,read:async client=>{
   if(choice.kind==='retired'||choice.kind==='preserved-native'){
    if(!passId)return false;
    if(choice.kind==='retired'){if(!await participant!.inspectRetiredIn(client,key,choice))return false;}
    else{const proof=await participant!.inspectNativeIn!(client,key,choice),certificate=await coverage!.readIn(client,key);if(proof.nativeBindingHash!==choice.nativeBindingHash||certificate?.kind!=='preserved-native'||certificate.nativeBindingHash!==choice.nativeBindingHash)return false;}
    if((await client.query('SELECT 1 FROM opencrawl_online_shadow_objects WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,key])).rows.length)unsafe();
    if(fromSource)await client.query(`INSERT INTO opencrawl_online_shadow_seen_retirements VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(namespace,epoch,source_id,source_key) DO UPDATE SET participant_identity=EXCLUDED.participant_identity,pass_id=EXCLUDED.pass_id,through_sequence=EXCLUDED.through_sequence`,[...scope,key,participantIdentity,passId,through]);
    const seen=(await client.query('SELECT participant_identity,pass_id,through_sequence::text FROM opencrawl_online_shadow_seen_retirements WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,key])).rows[0];
    return seen?.participant_identity===participantIdentity&&seen.pass_id===passId&&seen.through_sequence===through;
   }
   const actual=await read(client,key),observed=snapshot(await external.read(key,{maxBytes:choice.maxBytes}),choice.maxBytes);
   if(!actual||BigInt(actual.sequence)>BigInt(through))return false;
   const same=actual.deleted===observed.deleted&&actual.contentType===observed.contentType&&actual.sourceVersion===observed.version&&actual.operationId===observed.operationId&&(actual.revision==='0'?observed.revision===null:actual.revision===observed.revision)&&(actual.bytes===null?observed.bytes===null:observed.bytes!==null&&actual.bytes.equals(observed.bytes));
   return same&&(!participant||await participant.inspectIn(client,key,observed));
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
    if(selected(entry.key).kind==='preserved-native')unsafe();
    try{await journal.reconcile(entry.key,external);settled++;}
    catch(error){if(error&&typeof error==='object'&&'code' in error&&['ONLINE_MIGRATION_EXTERNAL_OUTCOME_UNCERTAIN','ONLINE_MIGRATION_UNRESOLVED_INTENT'].includes(String(error.code)))pending++;else throw error;}
    processed++;after=entry.sequence;
   }
   if(coverage&&performance.now()-started<30000){input.signal.throwIfAborted();const key=await coverage.nextDeferred();if(key!==null)await backfill(key);}
   return {cursor:exhausted?after:page.next,processed,pending,settled,budgetExhausted:exhausted||performance.now()-started>=30000};
  },
  async backfillPage(input){pageInput(input);const position=parseCursor(input.cursor);if(position.stage!=='source')unsafe();
   if(coverage){
    let page=await coverage.getPage({shard:input.shard,cursor:input.cursor,limit:input.limit});
    if(!page){const observed=await sourcePage(position,input.limit,input.signal);input.signal.throwIfAborted();page=await coverage.stagePage({shard:input.shard,cursor:input.cursor,next:encodeCursor(observed.next),limit:input.limit,entries:observed.keys.map(key=>coverageEntry(key,selected(key)))});}
    if(!page.complete){for(const v of page.entries){input.signal.throwIfAborted();const choice=selected(v.key);if(JSON.stringify(coverageEntry(v.key,choice))!==JSON.stringify(v))unsafe();if(choice.kind!=='immutable'&&shard(v.key)===input.shard){const result=await backfill(v.key);if(!result.applied)await coverage.defer(v.key);}}input.signal.throwIfAborted();page=await coverage.completePage(page);}
    return {cursor:page.next,processed:page.entries.length};
   }
   const page=await sourcePage(position,input.limit,input.signal);for(const key of page.keys){input.signal.throwIfAborted();if(selected(key).kind!=='immutable'&&shard(key)===input.shard)await backfill(key);}return {cursor:encodeCursor(page.next),processed:page.keys.length};},
  closedFrontier:()=>journal.closedFrontier(),
  async replayPage(input){pageInput(input);if(input.consumer!==bindingId+'-'+input.shard)unsafe();const result=await journal.replayPage({consumer:input.consumer,through:input.through,limit:input.limit,apply:async(client,intent)=>{input.signal.throwIfAborted();const choice=selected(intent.key);if(choice.kind==='preserved-native'||participant&&choice.kind==='immutable')unsafe();if(choice.kind!=='immutable'&&shard(intent.key)===input.shard)await applyJournal(client,intent);}});return {checkpoint:result.checkpoint,processed:result.applied+result.notApplied,blocked:result.pending};},
  async parityPage(input){pageInput(input);if(!decimal(input.through))unsafe();const checkpoint=await journal.replayCheckpoint(bindingId+'-'+input.shard);if(checkpoint===null||BigInt(checkpoint)<BigInt(input.through))unsafe();if(BigInt(checkpoint)>BigInt(input.through))return {cursor:null,processed:0,mismatches:0,drift:true};if(await drift(input.through))return {cursor:null,processed:0,mismatches:0,drift:true};const parsed=parityPosition(input.cursor,input.through,input.shard);let position=parsed.position,keys:string[],next:Cursor|null;const fromSource=position.stage==='source';
   if(position.stage==='source'){
    const page=await sourcePage(position,input.limit,input.signal);keys=page.keys;next=page.next??{stage:'shadow',after:''};
    if(keys.length===0)position={stage:'shadow',after:''};
   }else{keys=[];next=null;}
   if(position.stage==='shadow'){
    keys=await targetKeys(position.after,input.limit);
    next=keys.length===input.limit?{stage:'shadow',after:keys.at(-1)!}:null;
   }
   let mismatches=0,changed=false;for(const key of keys!){input.signal.throwIfAborted();if(selected(key).kind!=='immutable'&&shard(key)===input.shard){const result=await compare(key,input.through,parsed.passId,fromSource&&position.stage==='source');if(result.mismatch)mismatches++;changed ||= result.drift;}}
   changed ||= await drift(input.through);return {cursor:parityCursor(next!,input.through,input.shard,parsed.passId),processed:keys!.length,mismatches,drift:changed};
  },
 };
 return {bindingId,participantIdentity,ready,backfill,applyJournal,adapter,coverage:coverage?Object.freeze({identity:coverage.identity,status:coverage.status}):undefined};
}
