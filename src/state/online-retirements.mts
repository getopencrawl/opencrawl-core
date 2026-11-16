import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import type {IntegrationRecord} from '../integrations/types.mjs';
import type {OnlineIntent} from './online-journal.mjs';
import {createLegacyObjectClassifier} from './legacy-object-classification.mjs';

const domains=['session-scheduler-retirement','session-indexing','temporal-cutover','connector-indexing','connector-snapshots','record-counts'] as const;
export type OnlineRetirementDomain=typeof domains[number];
export interface OnlineRetirementClassification {domain:OnlineRetirementDomain;maxBytes:number;scopeHash:string}
export interface OnlineRetirementObservation {key:string;domain:string;scopeHash:string}
export type OnlineRetirementDisposition='full-current-session-catchup'|'full-current-connector-catchup'|'unavailable-until-count-rebuild';
interface CountScope {environment:string;tenantId:string;userId:string;connectionId:string;bucket:string;prefix:string}
export interface OnlineRetirementRecord {
 key:string;domain:OnlineRetirementDomain;scopeHash:string;disposition:OnlineRetirementDisposition;
 revision:string;sequence:string;operationId:string|null;deleted:boolean;sourceVersion:string|null;
 sourceHash:string|null;sourceBytes:number|null;contentType:string|null;requestHash:string|null;
}
const sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const identity=(value:unknown)=>digest(JSON.stringify(value));
function fail(message:string):never{throw Object.assign(new Error('Online retirement: '+message),{code:'ONLINE_RETIREMENT_INVALID'});}
function text(value:unknown,max:number):asserts value is string{if(typeof value!=='string'||!value||Buffer.byteLength(value)>max||/[\u0000-\u001f\u007f]/.test(value))fail('invalid scope text');}
function sequence(value:unknown):asserts value is string{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>9223372036854775807n)fail('invalid sequence');}
function integer(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('invalid byte count');return value;}
const disposition=(domain:OnlineRetirementDomain):OnlineRetirementDisposition=>domain==='record-counts'?'unavailable-until-count-rebuild':domain.startsWith('connector-')?'full-current-connector-catchup':'full-current-session-catchup';
const columns='source_key,domain,scope_hash,disposition,revision::text,source_sequence::text,operation_id::text,deleted,source_version,source_hash,source_bytes,content_type,request_hash';

/** Migration-only audit of explicitly retired derived objects. No raw bodies,
 * old cursor, old completion marker or count enters a runtime repository.
 * Caller owns the journal key gate AND transaction for backfill/apply/inspect.
 * Registry scope is an explicit frozen enrollment snapshot; a new connection
 * requires separately reviewed enrollment, not authority inferred from its key. */
export function createOnlineRetirements({database,epoch,sourceId,journalBinding,source,registryRecords=[],tenantIds=[]}:{
 database:ApplicationDatabase;epoch:string;sourceId:string;journalBinding:Readonly<{namespace:string;epoch:string;sourceId:string}>;
 source:{bucket:string;prefix:string};registryRecords?:readonly IntegrationRecord[];tenantIds?:readonly string[];
}){
 const namespace=database.namespace,bucket=source.bucket,prefix=source.prefix;text(namespace,2048);text(sourceId,2048);text(bucket,1024);
 if(!uuid.test(epoch)||journalBinding.namespace!==namespace||journalBinding.epoch!==epoch||journalBinding.sourceId!==sourceId)fail('journal binding differs');
 const classifier=createLegacyObjectClassifier({prefix}),scope=[namespace,epoch,sourceId];
 if(tenantIds.length>100000||registryRecords.length>100000)fail('enrollment scope exceeds bound');
 const tenants=new Set(tenantIds);if(tenants.size!==tenantIds.length||tenantIds.some(id=>!/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(id)))fail('invalid enrolled tenant set');
 const countScopes:CountScope[]=registryRecords.filter(record=>(record.s3Bucket||bucket)===bucket).map(record=>({environment:record.environment,tenantId:record.tenantId,userId:record.userId,connectionId:record.integrationId,bucket,prefix:record.s3Prefix??''}));
 countScopes.sort((a,b)=>Buffer.compare(Buffer.from(JSON.stringify(a)),Buffer.from(JSON.stringify(b))));
 const policy=JSON.stringify({format:1,source:{bucket,prefix},domains,tenants:[...tenants].sort(),countScopes});if(Buffer.byteLength(policy)>8*1024*1024)fail('enrollment policy exceeds byte bound');
 const policyHash=digest(policy),binding=Object.freeze({namespace,epoch,sourceId,policyHash}),sourceBinding=Object.freeze({bucket,prefix});
 function countScope(connectionId:string){
  const found=countScopes.filter(record=>record.connectionId===connectionId);
  if(found.length!==1)fail('counts require one enrolled registry connection');const value=found[0];
  if(!tenants.has(value.tenantId)||!['production','staging','selfhost'].includes(value.environment)||!/^user_[A-Za-z0-9]+$/.test(value.userId)||!/^int_[a-f0-9]{26}$/.test(value.connectionId))fail('counts owner is not enrolled');
  text(value.prefix,8192);if(value.prefix.split('/').some(part=>!part||part==='.'||part==='..'))fail('invalid count source prefix');return value;
 }
 function classify(key:string):OnlineRetirementClassification|null{
  const found=classifier.classify(key);if(!found||!domains.includes(found.domain as OnlineRetirementDomain))return null;
  const domain=found.domain as OnlineRetirementDomain;
  return {domain,maxBytes:found.maxBytes,scopeHash:identity({bucket,prefix,domain,parts:found.parts,...(domain==='record-counts'?{connection:countScope(found.parts[0])}:{})})};
 }
 function observation(input:OnlineRetirementObservation):OnlineRetirementClassification&{key:string}{
  const found=classify(input.key);if(!found||found.domain!==input.domain||found.scopeHash!==input.scopeHash)fail('source classification differs');return {key:input.key,...found};
 }
 function decode(row:Record<string,any>):OnlineRetirementRecord{
  const observed=observation({key:row.source_key,domain:row.domain,scopeHash:row.scope_hash});sequence(row.revision);sequence(row.source_sequence);
  if(row.disposition!==disposition(observed.domain)||typeof row.deleted!=='boolean')fail('stored disposition changed');
  const value:OnlineRetirementRecord={key:observed.key,domain:observed.domain,scopeHash:observed.scopeHash,disposition:row.disposition,revision:row.revision,sequence:row.source_sequence,operationId:row.operation_id,deleted:row.deleted,sourceVersion:row.source_version,sourceHash:row.source_hash,sourceBytes:row.source_bytes===null?null:integer(row.source_bytes),contentType:row.content_type,requestHash:row.request_hash};
  if(value.revision==='0'){
   if(value.sequence!=='0'||value.operationId!==null||value.deleted||value.sourceVersion!==null||value.sourceHash!==null||value.sourceBytes!==null||value.contentType!==null||value.requestHash!==null)fail('listed-key baseline contains invented body evidence');
  }else{
   if(value.sequence==='0'||!uuid.test(value.operationId??'')||!sha.test(value.requestHash??''))fail('stored journal identity differs');text(value.sourceVersion,2048);
   if(value.deleted){if(value.sourceHash!==null||value.sourceBytes!==null||value.contentType!==null)fail('tombstone contains payload evidence');}
   else{if(!sha.test(value.sourceHash??'')||value.sourceBytes===null||value.sourceBytes>observed.maxBytes)fail('stored payload metadata differs');text(value.contentType,256);}
  }return value;
 }
 async function assertBindingIn(client:PoolClient){const row=(await client.query('SELECT policy_hash FROM opencrawl_online_retirement_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];if(row?.policy_hash!==policyHash)fail('retirement source policy changed');}
 async function readIn(client:PoolClient,input:OnlineRetirementObservation){
  const {key}=observation(input);await assertBindingIn(client);const row=(await client.query(`SELECT ${columns} FROM opencrawl_online_retirements WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4`,[...scope,key])).rows[0];return row?decode(row):null;
 }
 async function journalIn(client:PoolClient,key:string,operationId?:string){
  return (await client.query(`SELECT revision::text,sequence::text,operation_id::text,kind,state,result_version,payload_hash,octet_length(payload) AS source_bytes,content_type,request_hash
   FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND ${operationId?'operation_id=$5':"state IN ('pending','applied') ORDER BY revision DESC LIMIT 1"}`,[...scope,key,...(operationId?[operationId]:[])])).rows[0];
 }
 function matchesJournal(value:OnlineRetirementRecord,row:Record<string,any>|undefined){return Boolean(row&&['put','delete'].includes(row.kind)&&row.state==='applied'&&value.revision===row.revision&&value.sequence===row.sequence&&value.operationId===row.operation_id&&value.deleted===(row.kind==='delete')&&value.sourceVersion===row.result_version&&value.sourceHash===row.payload_hash&&value.sourceBytes===row.source_bytes&&value.contentType===row.content_type&&value.requestHash===row.request_hash);}
 async function saveIn(client:PoolClient,value:OnlineRetirementRecord){
  await client.query(`INSERT INTO opencrawl_online_retirements(namespace,epoch,source_id,source_key,domain,scope_hash,disposition,revision,source_sequence,operation_id,deleted,source_version,source_hash,source_bytes,content_type,request_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(namespace,epoch,source_id,source_key) DO UPDATE SET revision=EXCLUDED.revision,source_sequence=EXCLUDED.source_sequence,operation_id=EXCLUDED.operation_id,deleted=EXCLUDED.deleted,source_version=EXCLUDED.source_version,source_hash=EXCLUDED.source_hash,source_bytes=EXCLUDED.source_bytes,content_type=EXCLUDED.content_type,request_hash=EXCLUDED.request_hash`,[...scope,value.key,value.domain,value.scopeHash,value.disposition,value.revision,value.sequence,value.operationId,value.deleted,value.sourceVersion,value.sourceHash,value.sourceBytes,value.contentType,value.requestHash]);
  if(!isDeepStrictEqual(await readIn(client,value),value))fail('independent retirement readback differs');
 }
 let preparing:Promise<void>|undefined;
 async function ready(){preparing??=(async()=>{await database.ready();await database.transaction(async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-retirements:schema',0))");
  await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_retirement_bindings(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,policy_hash text NOT NULL CHECK(policy_hash~'^[a-f0-9]{64}$'),PRIMARY KEY(namespace,epoch,source_id));
   CREATE TABLE IF NOT EXISTS opencrawl_online_retirements(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,domain text NOT NULL CHECK(domain IN('session-scheduler-retirement','session-indexing','temporal-cutover','connector-indexing','connector-snapshots','record-counts')),
   scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),disposition text NOT NULL CHECK(disposition IN('full-current-session-catchup','full-current-connector-catchup','unavailable-until-count-rebuild')),revision bigint NOT NULL CHECK(revision>=0),source_sequence bigint NOT NULL CHECK(source_sequence>=0),operation_id uuid,deleted boolean NOT NULL,source_version text,source_hash text,source_bytes integer CHECK(source_bytes>=0 AND source_bytes<=67108864),content_type text,request_hash text,
   PRIMARY KEY(namespace,epoch,source_id,source_key),FOREIGN KEY(namespace,epoch,source_id) REFERENCES opencrawl_online_retirement_bindings(namespace,epoch,source_id),
   CHECK((revision=0 AND source_sequence=0 AND operation_id IS NULL AND NOT deleted AND source_version IS NULL AND source_hash IS NULL AND source_bytes IS NULL AND content_type IS NULL AND request_hash IS NULL) OR
    (revision>0 AND source_sequence>0 AND operation_id IS NOT NULL AND source_version IS NOT NULL AND request_hash IS NOT NULL AND request_hash~'^[a-f0-9]{64}$' AND ((deleted AND source_hash IS NULL AND source_bytes IS NULL AND content_type IS NULL) OR (NOT deleted AND source_hash IS NOT NULL AND source_hash~'^[a-f0-9]{64}$' AND source_bytes IS NOT NULL AND content_type IS NOT NULL)))))`);
  await client.query('INSERT INTO opencrawl_online_retirement_bindings VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,policyHash]);await assertBindingIn(client);
 });})().catch(error=>{preparing=undefined;throw error;});await preparing;}
 async function backfillIn(client:PoolClient,input:OnlineRetirementObservation){
  const observed=observation(input);await assertBindingIn(client);
  if(await journalIn(client,observed.key))fail('baseline key has pending or applied journal history');
  const prior=await readIn(client,observed);if(prior){if(prior.revision!=='0')fail('baseline would overwrite replay');return;}
  await saveIn(client,{key:observed.key,domain:observed.domain,scopeHash:observed.scopeHash,disposition:disposition(observed.domain),revision:'0',sequence:'0',operationId:null,deleted:false,sourceVersion:null,sourceHash:null,sourceBytes:null,contentType:null,requestHash:null});
 }
 async function applyIn(client:PoolClient,intent:OnlineIntent,input:Omit<OnlineRetirementObservation,'key'>){
  // Hash/copy scalar metadata before awaiting SQL. Payloads are never retained.
  const observed=observation({key:intent.key,...input});
  if(intent.namespace!==namespace||intent.epoch!==epoch||intent.sourceId!==sourceId||intent.state!=='applied'||!uuid.test(intent.operationId)||!sha.test(intent.requestHash)||!intent.resultVersion)fail('intent is not applied in this source');
  sequence(intent.revision);sequence(intent.sequence);if(intent.revision==='0'||intent.sequence==='0')fail('journal revision cannot be baseline');
  if(intent.mutation.kind!=='put'&&intent.mutation.kind!=='delete')fail('unknown journal mutation');
  const mutation=intent.mutation,put=mutation.kind==='put';if(mutation.kind==='put'&&(!Buffer.isBuffer(mutation.bytes)||mutation.bytes.length>observed.maxBytes))fail('derived source exceeds its declared bound');
  const value:OnlineRetirementRecord={key:observed.key,domain:observed.domain,scopeHash:observed.scopeHash,disposition:disposition(observed.domain),revision:intent.revision,sequence:intent.sequence,operationId:intent.operationId,deleted:!put,sourceVersion:intent.resultVersion,sourceHash:mutation.kind==='put'?digest(mutation.bytes):null,sourceBytes:mutation.kind==='put'?mutation.bytes.length:null,contentType:mutation.kind==='put'?mutation.contentType:null,requestHash:intent.requestHash};
  text(value.sourceVersion,2048);if(put)text(value.contentType,256);await assertBindingIn(client);
  if(!matchesJournal(value,await journalIn(client,value.key,value.operationId!)))fail('applied intent differs from durable journal');
  const prior=await readIn(client,observed);if(prior){if(BigInt(prior.revision)>BigInt(value.revision)||BigInt(prior.sequence)>BigInt(value.sequence))fail('stale retirement replay');if(prior.revision===value.revision){if(!isDeepStrictEqual(prior,value))fail('retirement revision was reused');return;}if(BigInt(prior.sequence)>=BigInt(value.sequence))fail('retirement sequence did not advance');}
  await saveIn(client,value);
 }
 async function inspectIn(client:PoolClient,input:OnlineRetirementObservation){
  const observed=observation(input),value=await readIn(client,observed);if(!value)return false;
  const latest=await journalIn(client,observed.key);return value.revision==='0'?!latest:matchesJournal(value,latest);
 }
 async function keysPageIn(client:PoolClient,{after,limit}:{after:string;limit:number}){
  if(after)text(after,8192);if(typeof after!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>64)fail('invalid retirement page');await assertBindingIn(client);
  return (await client.query('SELECT source_key FROM opencrawl_online_retirements WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key>$4 COLLATE "C" ORDER BY source_key COLLATE "C" LIMIT $5',[...scope,after,limit])).rows.map(row=>{text(row.source_key,8192);return row.source_key as string;});
 }
 /** One bounded page of obligations, not a complete inventory or readiness.
  * Caller must retain ONE RR snapshot for every page, verify full source/key
  * coverage, and later bind final authority/fleet handoff. No offline receipts
  * are fabricated. Deleted keys still require current-scope catch-up. */
 async function requirementsPageIn(client:PoolClient,{through,after='',limit=64}:{through:string;after?:string;limit?:number}){
  sequence(through);const settings=(await client.query("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only")).rows[0];
  if(!settings||!['repeatable read','serializable'].includes(settings.isolation)||settings.read_only!=='on')fail('requirements need one read-only repeatable snapshot');
  const frontier=(await client.query(`SELECT s.sequence::text AS allocated,COALESCE((SELECT min(j.sequence)-1 FROM opencrawl_online_migration_journal j WHERE j.namespace=s.namespace AND j.epoch=s.epoch AND j.source_id=s.source_id AND j.state='pending'),s.sequence)::text AS closed FROM opencrawl_online_migration_sources s WHERE namespace=$1 AND epoch=$2 AND source_id=$3`,scope)).rows[0];
  if(!frontier)fail('journal source is absent');sequence(frontier.allocated);sequence(frontier.closed);if(frontier.closed!==through||BigInt(frontier.closed)>BigInt(frontier.allocated))fail('requested frontier is not currently closed');
  const keys=await keysPageIn(client,{after,limit}),records:OnlineRetirementRecord[]=[];
  for(const key of keys){const observed={key,...classify(key)!};if(!await inspectIn(client,observed))fail('retirement is behind its source journal');const value=(await readIn(client,observed))!;if(BigInt(value.sequence)>BigInt(through))fail('retirement is newer than the closed frontier');records.push(value);}
  return {binding,source:{bucket,prefix},through,pending:frontier.closed!==frontier.allocated,records,next:keys.length===limit?keys[keys.length-1]:null,
   receiptIdentity:identity({format:1,binding,source:{bucket,prefix},through,after,records}),applicationReady:false as const,catchupComplete:false as const,keyCoverageComplete:false as const};
 }
 return {binding,source:sourceBinding,classify,ready,backfillIn,applyIn,inspectIn,keysPageIn,readIn,requirementsPageIn};
}
