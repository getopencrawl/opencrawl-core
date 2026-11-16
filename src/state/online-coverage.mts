import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {ensureSchemaIndex} from './postgres.mjs';

/** Migration evidence only. A completed traversal is not runtime admission. */
export interface OnlineCoverageAuthority {namespace:string;epoch:string;protocol:string;enrollmentReceiptHash:string}
export interface OnlineCoveragePolicy {authority:OnlineCoverageAuthority;policyHash:string}
export interface OnlineCoverageTarget {targetKey:string;targetHash:string}
export interface OnlineCoverageEntry {key:string;kind:'retained'|'retired'|'immutable'|'preserved-native';domain:string|null;scopeHash:string|null;nativeBindingHash?:string}
export interface OnlineCoverageEvidence extends OnlineCoverageEntry {
 revision:string;sequence:string;operationId:string|null;sourceVersion:string|null;sourceHash:string|null;sourceBytes:number|null;deleted:boolean;
 targetKey:string|null;targetHash:string|null;absent:boolean;
}
export interface OnlineCoveragePage {shard:number;number:string;cursor:string|null;next:string|null;limit:number;entries:OnlineCoverageEntry[];hash:string;complete:boolean}
const sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ordered=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
function fail(code:string):never{throw Object.assign(new Error('Online coverage: '+code),{code:'ONLINE_COVERAGE_'+code});}
function text(value:unknown,max:number):asserts value is string{if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>max)fail('INVALID_TEXT');}
function sequence(value:unknown):asserts value is string{if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>9223372036854775807n)fail('INVALID_SEQUENCE');}
function cursor(value:unknown):asserts value is string|null{if(value!==null)text(value,8192);}
function entry(input:OnlineCoverageEntry):OnlineCoverageEntry{
 text(input.key,8192);if(!['retained','retired','immutable','preserved-native'].includes(input.kind))fail('INVALID_DISPOSITION');
 if(input.kind==='immutable'){if(input.domain!==null||input.scopeHash!==null)fail('INVALID_IMMUTABLE');}
 else{text(input.domain,200);if(input.kind==='retired'?!sha.test(input.scopeHash??''):input.scopeHash!==null)fail('INVALID_SCOPE');}
 if(input.kind==='preserved-native'){if(input.domain!=='event-identities'||!sha.test(input.nativeBindingHash??''))fail('INVALID_NATIVE_BINDING');}else if(input.nativeBindingHash!==undefined)fail('UNEXPECTED_NATIVE_BINDING');
 return {key:input.key,kind:input.kind,domain:input.domain,scopeHash:input.scopeHash,...(input.kind==='preserved-native'?{nativeBindingHash:input.nativeBindingHash!}:{})};
}
function evidence(input:OnlineCoverageEvidence):OnlineCoverageEvidence{
 const selected=entry(input);if(selected.kind==='immutable')fail('IMMUTABLE_HAS_NO_TARGET');sequence(input.revision);sequence(input.sequence);
 if(typeof input.deleted!=='boolean'||typeof input.absent!=='boolean')fail('INVALID_EVIDENCE');
 if(input.operationId!==null&&!uuid.test(input.operationId)||input.sourceVersion!==null&&(typeof input.sourceVersion!=='string'||!input.sourceVersion||Buffer.byteLength(input.sourceVersion)>2048))fail('INVALID_SOURCE_IDENTITY');
 if(input.sourceHash!==null&&!sha.test(input.sourceHash)||input.sourceBytes!==null&&(!Number.isSafeInteger(input.sourceBytes)||input.sourceBytes<0||input.sourceBytes>67108864))fail('INVALID_SOURCE_BYTES');
 if(input.revision==='0'?input.sequence!=='0'||input.operationId!==null:input.sequence==='0'||input.operationId===null||input.sourceVersion===null||input.absent)fail('INVALID_SOURCE_REVISION');
 if(input.kind==='preserved-native'){if(input.revision!=='0'||input.sequence!=='0'||input.operationId!==null||input.sourceVersion!==null||input.sourceHash!==null||input.sourceBytes!==null||input.deleted||input.absent||input.targetKey!==null||input.targetHash!==null)fail('INVENTED_NATIVE_EVIDENCE');}
 else if(input.absent){if(input.kind!=='retained'||input.revision!=='0'||!input.deleted||input.sourceVersion!==null||input.sourceHash!==null||input.sourceBytes!==null||input.targetKey!==null||input.targetHash!==null)fail('INVALID_ABSENCE');}
 else{text(input.targetKey,16384);if(!sha.test(input.targetHash??''))fail('INVALID_TARGET');}
 if(input.kind==='retired'&&input.revision==='0'){if(input.deleted||input.sourceVersion!==null||input.sourceHash!==null||input.sourceBytes!==null)fail('INVENTED_RETIRED_BASELINE');}
 else if(input.kind==='preserved-native'){/* Native proof is metadata-only, validated above. */}
 else if(input.deleted){if(input.sourceHash!==null||input.sourceBytes!==null)fail('TOMBSTONE_HAS_BYTES');}
 else if(!sha.test(input.sourceHash??'')||input.sourceBytes===null||input.sourceVersion===null)fail('MISSING_SOURCE_BYTES');
 return {...selected,revision:input.revision,sequence:input.sequence,operationId:input.operationId,sourceVersion:input.sourceVersion,sourceHash:input.sourceHash,sourceBytes:input.sourceBytes,deleted:input.deleted,targetKey:input.targetKey,targetHash:input.targetHash,absent:input.absent};
}
export function createOnlineCoverage({database,epoch,sourceId,targetId,shards,roots:inputRoots,participantIdentity,policy:inputPolicy}:{
 database:{pool:Pool;namespace:string};epoch:string;sourceId:string;targetId:string;shards:number;roots:readonly string[];participantIdentity:string;policy:OnlineCoveragePolicy;
}){
 const namespace=database.namespace;text(namespace,2048);text(sourceId,2048);text(targetId,2048);
 if(!uuid.test(epoch)||!Number.isSafeInteger(shards)||shards<1||shards>256||!sha.test(participantIdentity))fail('INVALID_BINDING');
 const roots=Object.freeze([...inputRoots]);if(!roots.length||roots.length>32)fail('INVALID_ROOTS');for(const root of roots)text(root,4096);
 if(roots.some((a,i)=>roots.some((b,j)=>i!==j&&(a.startsWith(b)||b.startsWith(a)))))fail('OVERLAPPING_ROOTS');
 const policy=Object.freeze({policyHash:inputPolicy.policyHash,authority:Object.freeze({...inputPolicy.authority})});
 if(!sha.test(policy.policyHash)||policy.authority.namespace!==namespace||policy.authority.epoch!==epoch||!sha.test(policy.authority.enrollmentReceiptHash))fail('AUTHORITY_BINDING');text(policy.authority.protocol,256);
 const binding=Object.freeze({namespace,epoch,sourceId,targetId,shards,roots,participantIdentity,policy}),identity=digest(binding),scope=[namespace,epoch,sourceId];
 const owner=(key:string)=>createHash('sha256').update(key).digest().readUInt32BE(0)%shards;
 const inScope=(key:string)=>{if(!roots.some(root=>key.startsWith(root)))fail('KEY_OUTSIDE_ROOTS');};
 let preparing:Promise<void>|undefined;
 async function transaction<T>(run:(client:PoolClient)=>Promise<T>){const client=await database.pool.connect();let failed=false;try{await client.query('BEGIN');const value=await run(client);await client.query('COMMIT');return value;}catch(error){failed=true;await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release(failed);}}
 async function boundIn(client:PoolClient){const row=(await client.query('SELECT identity FROM opencrawl_online_coverage_bindings WHERE namespace=$1 AND epoch=$2 AND source_id=$3',scope)).rows[0];if(row?.identity!==identity)fail('BINDING_CHANGED');}
 async function ready(){preparing??=transaction(async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-coverage:schema',0))");
  await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_coverage_bindings(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,identity text NOT NULL CHECK(identity~'^[a-f0-9]{64}$'),repair_counter bigint NOT NULL DEFAULT 0 CHECK(repair_counter>=0),PRIMARY KEY(namespace,epoch,source_id));
   CREATE TABLE IF NOT EXISTS opencrawl_online_coverage_traversals(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,shard integer NOT NULL CHECK(shard>=0 AND shard<256),next_page bigint NOT NULL DEFAULT 0 CHECK(next_page>=0),cursor text CHECK(octet_length(cursor)<=8192),complete boolean NOT NULL DEFAULT false,page_chain text NOT NULL CHECK(page_chain~'^[a-f0-9]{64}$'),encountered bigint NOT NULL DEFAULT 0 CHECK(encountered>=0),PRIMARY KEY(namespace,epoch,source_id,shard),CHECK(NOT complete OR cursor IS NULL));
   CREATE TABLE IF NOT EXISTS opencrawl_online_coverage_pages(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,shard integer NOT NULL,page_number bigint NOT NULL CHECK(page_number>=0),request_hash text NOT NULL,request_cursor text,next_cursor text,page_limit integer NOT NULL CHECK(page_limit>0 AND page_limit<=64),entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='array' AND jsonb_array_length(entries)<=64 AND octet_length(entries::text)<=1048576),page_hash text NOT NULL CHECK(page_hash~'^[a-f0-9]{64}$'),complete boolean NOT NULL DEFAULT false,PRIMARY KEY(namespace,epoch,source_id,shard,page_number),UNIQUE(namespace,epoch,source_id,shard,request_hash));
   CREATE TABLE IF NOT EXISTS opencrawl_online_coverage_encounters(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,shard integer NOT NULL,page_number bigint NOT NULL,kind text NOT NULL CHECK(kind IN('retained','retired','immutable','preserved-native')),domain text,scope_hash text,outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN('pending','deferred','immutable','certified')),deferred_operation uuid,attempt bigint NOT NULL DEFAULT 0 CHECK(attempt>=0),PRIMARY KEY(namespace,epoch,source_id,source_key));
   CREATE TABLE IF NOT EXISTS opencrawl_online_coverage_certificates(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,kind text NOT NULL CHECK(kind IN('retained','retired','preserved-native')),domain text NOT NULL,scope_hash text,revision bigint NOT NULL CHECK(revision>=0),source_sequence bigint NOT NULL CHECK(source_sequence>=0),operation_id uuid,source_version text,source_hash text,source_bytes integer CHECK(source_bytes>=0 AND source_bytes<=67108864),deleted boolean NOT NULL,target_key text,target_hash text,absent boolean NOT NULL,certificate_hash text NOT NULL CHECK(certificate_hash~'^[a-f0-9]{64}$'),PRIMARY KEY(namespace,epoch,source_id,source_key))`);
  // Additive migration evidence schema only. Never relax an unknown constraint.
  for(const [table,previous,current] of [
   ['opencrawl_online_coverage_encounters',['retained','retired','immutable'],['retained','retired','immutable','preserved-native']],
   ['opencrawl_online_coverage_certificates',['retained','retired'],['retained','retired','preserved-native']],
  ] as const){
   const checks=(await client.query(`SELECT c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c WHERE c.conrelid=to_regclass($1) AND c.conname=$2 AND c.contype='c'`,[table,table+'_kind_check'])).rows;
   const rendered=(values:readonly string[])=>"CHECK ((kind = ANY (ARRAY["+values.map(v=>"'"+v+"'::text").join(', ')+"])))";
   if(checks.length!==1||!checks[0].convalidated)fail('NATIVE_SCHEMA_CONSTRAINT');
   if(checks[0].definition===rendered(previous))await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_kind_check,ADD CONSTRAINT ${table}_kind_check CHECK(kind IN(${current.map(v=>"'"+v+"'").join(',')}))`);
   else if(checks[0].definition!==rendered(current))fail('NATIVE_SCHEMA_CONSTRAINT');
   const column=(await client.query(`SELECT atttypid::regtype::text AS type,attnotnull,atthasdef,attidentity,attgenerated FROM pg_attribute WHERE attrelid=to_regclass($1) AND attname='native_binding_hash' AND NOT attisdropped`,[table])).rows[0];
   if(!column)await client.query(`ALTER TABLE ${table} ADD COLUMN native_binding_hash text`);
   else if(column.type!=='text'||column.attnotnull||column.atthasdef||column.attidentity||column.attgenerated)fail('NATIVE_SCHEMA_COLUMN');
  }
  await ensureSchemaIndex(client,{table:'opencrawl_online_coverage_encounters',name:'opencrawl_online_coverage_deferred',keys:['namespace','epoch','source_id','attempt','source_key'],predicate:{column:'outcome',equals:'deferred'}});
  await ensureSchemaIndex(client,{table:'opencrawl_online_coverage_encounters',name:'opencrawl_online_coverage_pending',keys:['namespace','epoch','source_id','source_key'],predicate:{column:'outcome',equals:'pending'}});
  for(const table of ['opencrawl_online_coverage_encounters','opencrawl_online_coverage_certificates'])await ensureSchemaIndex(client,{table,name:table+'_native',keys:['namespace','epoch','source_id','source_key'],predicate:{column:'kind',equals:'preserved-native'}});
  await client.query('INSERT INTO opencrawl_online_coverage_bindings(namespace,epoch,source_id,identity) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...scope,identity]);await boundIn(client);
 }).catch(error=>{preparing=undefined;throw error;});await preparing;}
 function pageHash(p:Omit<OnlineCoveragePage,'hash'|'complete'>){return digest([identity,p.shard,p.number,p.cursor,p.next,p.limit,p.entries]);}
 function decodePage(row:Record<string,any>):OnlineCoveragePage{
  sequence(row.page_number);cursor(row.request_cursor);cursor(row.next_cursor);if(!Number.isInteger(row.shard)||row.shard<0||row.shard>=shards||!Number.isInteger(row.page_limit)||row.page_limit<1||row.page_limit>64||!Array.isArray(row.entries)||row.entries.length>row.page_limit||typeof row.complete!=='boolean')fail('INVALID_PAGE');
  const p={shard:row.shard,number:row.page_number,cursor:row.request_cursor,next:row.next_cursor,limit:row.page_limit,entries:row.entries.map(entry),hash:row.page_hash,complete:row.complete};
  if(p.entries.some((v:OnlineCoverageEntry)=>{inScope(v.key);return false;})||p.hash!==pageHash(p)||row.request_hash!==digest(p.cursor))fail('PAGE_CHANGED');return p;
 }
 const pageColumns='shard,page_number::text,request_hash,request_cursor,next_cursor,page_limit,entries,page_hash,complete';
 async function lookupIn(client:PoolClient,shard:number,request:string|null){const row=(await client.query(`SELECT ${pageColumns} FROM opencrawl_online_coverage_pages WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 AND request_hash=$5`,[...scope,shard,digest(request)])).rows[0];if(!row)return null;const p=decodePage(row);if(p.cursor!==request)fail('CURSOR_HASH_COLLISION');return p;}
 function pageInput(shard:number,request:string|null,limit:number){if(!Number.isInteger(shard)||shard<0||shard>=shards||!Number.isInteger(limit)||limit<1||limit>64)fail('INVALID_PAGE_REQUEST');cursor(request);}
 async function getPage({shard,cursor:request,limit}:{shard:number;cursor:string|null;limit:number}){
  pageInput(shard,request,limit);return transaction(async client=>{
   await boundIn(client);const prior=await lookupIn(client,shard,request);if(prior){if(prior.limit!==limit)fail('PAGE_LIMIT_CHANGED');return prior;}
   const walk=(await client.query('SELECT cursor,complete FROM opencrawl_online_coverage_traversals WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4',[...scope,shard])).rows[0];
   if(walk?walk.complete||walk.cursor!==request:request!==null)fail('MISSING_PREDECESSOR_PAGE');return null;
  });
 }
 async function stagePage(input:{shard:number;cursor:string|null;next:string|null;limit:number;entries:readonly OnlineCoverageEntry[]}){
  pageInput(input.shard,input.cursor,input.limit);cursor(input.next);if(input.next!==null&&input.next===input.cursor||!Array.isArray(input.entries)||input.entries.length>input.limit)fail('INVALID_NEXT_PAGE');
  const proposed={shard:input.shard,cursor:input.cursor,next:input.next,limit:input.limit,entries:input.entries.map(entry)};for(const v of proposed.entries)inScope(v.key);if(proposed.entries.some((v,i)=>i>0&&ordered(proposed.entries[i-1]!.key,v.key)>=0)||Buffer.byteLength(JSON.stringify(proposed.entries))>1048576)fail('INVALID_PAGE_ENTRIES');
  return transaction(async client=>{
   await boundIn(client);await client.query('INSERT INTO opencrawl_online_coverage_traversals(namespace,epoch,source_id,shard,page_chain) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[...scope,proposed.shard,digest([identity,proposed.shard])]);
   const walk=(await client.query('SELECT next_page::text,cursor,complete FROM opencrawl_online_coverage_traversals WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 FOR UPDATE',[...scope,proposed.shard])).rows[0];
   const prior=await lookupIn(client,proposed.shard,proposed.cursor);if(prior){if(prior.limit!==proposed.limit)fail('PAGE_LIMIT_CHANGED');return prior;}
   if(walk.complete||walk.cursor!==proposed.cursor)fail('MISSING_PREDECESSOR_PAGE');sequence(walk.next_page);
   const page={...proposed,number:walk.next_page as string,hash:'',complete:false};page.hash=pageHash(page);
   await client.query('INSERT INTO opencrawl_online_coverage_pages VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)',[...scope,page.shard,page.number,digest(page.cursor),page.cursor,page.next,page.limit,JSON.stringify(page.entries),page.hash]);
   for(const v of page.entries)if(owner(v.key)===page.shard){
    const added=await client.query('INSERT INTO opencrawl_online_coverage_encounters(namespace,epoch,source_id,source_key,shard,page_number,kind,domain,scope_hash,native_binding_hash,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',[...scope,v.key,page.shard,page.number,v.kind,v.domain,v.scopeHash,v.nativeBindingHash??null,v.kind==='immutable'?'immutable':'pending']);
    if(added.rowCount!==1)fail('KEY_REPEATED_ACROSS_PAGES');
   }return page;
  });
 }
 const certificateColumns='source_key,kind,domain,scope_hash,native_binding_hash,revision::text,source_sequence::text,operation_id::text,source_version,source_hash,source_bytes,deleted,target_key,target_hash,absent,certificate_hash';
 function decodeCertificate(row:Record<string,any>){const value=evidence({key:row.source_key,kind:row.kind,domain:row.domain,scopeHash:row.scope_hash,...(row.native_binding_hash===null?{}:{nativeBindingHash:row.native_binding_hash}),revision:row.revision,sequence:row.source_sequence,operationId:row.operation_id,sourceVersion:row.source_version,sourceHash:row.source_hash,sourceBytes:row.source_bytes,deleted:row.deleted,targetKey:row.target_key,targetHash:row.target_hash,absent:row.absent});if(row.certificate_hash!==digest([identity,value]))fail('CERTIFICATE_CHANGED');return value;}
 async function readIn(client:PoolClient,key:string){text(key,8192);inScope(key);await boundIn(client);const row=(await client.query(`SELECT ${certificateColumns} FROM opencrawl_online_coverage_certificates WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4`,[...scope,key])).rows[0];return row?decodeCertificate(row):null;}
 async function recordIn(client:PoolClient,input:OnlineCoverageEvidence){
  const value=evidence(input);inScope(value.key);await boundIn(client);
  const actual=(await client.query("SELECT operation_id::text,revision::text,sequence::text,state,result_version,kind,payload_hash,octet_length(payload) AS bytes FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND "+(value.revision==='0'?(value.kind==='preserved-native'?"true LIMIT 1":"state<>'notApplied' LIMIT 1"):"operation_id=$5"),[...scope,value.key,...(value.revision==='0'?[]:[value.operationId])])).rows[0];
  if(value.revision==='0'){if(actual)fail('BASELINE_HAS_MUTATION');}
  else if(!actual||actual.state!=='applied'||actual.revision!==value.revision||actual.sequence!==value.sequence||actual.result_version!==value.sourceVersion||(actual.kind==='delete')!==value.deleted||actual.payload_hash!==value.sourceHash||actual.bytes!==value.sourceBytes)fail('JOURNAL_EVIDENCE_CHANGED');
  const prior=await readIn(client,value.key);if(prior){if(BigInt(prior.revision)>BigInt(value.revision)||BigInt(prior.sequence)>BigInt(value.sequence))fail('STALE_CERTIFICATE');if(prior.revision===value.revision){if(!isDeepStrictEqual(prior,value))fail('REUSED_CERTIFICATE_REVISION');return;}if(prior.kind!==value.kind||prior.domain!==value.domain||prior.scopeHash!==value.scopeHash||prior.nativeBindingHash!==value.nativeBindingHash)fail('DISPOSITION_CHANGED');}
  await client.query(`INSERT INTO opencrawl_online_coverage_certificates(namespace,epoch,source_id,source_key,kind,domain,scope_hash,revision,source_sequence,operation_id,source_version,source_hash,source_bytes,deleted,target_key,target_hash,absent,certificate_hash,native_binding_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
   ON CONFLICT(namespace,epoch,source_id,source_key) DO UPDATE SET revision=EXCLUDED.revision,source_sequence=EXCLUDED.source_sequence,operation_id=EXCLUDED.operation_id,source_version=EXCLUDED.source_version,source_hash=EXCLUDED.source_hash,source_bytes=EXCLUDED.source_bytes,deleted=EXCLUDED.deleted,target_key=EXCLUDED.target_key,target_hash=EXCLUDED.target_hash,absent=EXCLUDED.absent,certificate_hash=EXCLUDED.certificate_hash`,[...scope,value.key,value.kind,value.domain,value.scopeHash,value.revision,value.sequence,value.operationId,value.sourceVersion,value.sourceHash,value.sourceBytes,value.deleted,value.targetKey,value.targetHash,value.absent,digest([identity,value]),value.nativeBindingHash??null]);
  if(!isDeepStrictEqual(await readIn(client,value.key),value))fail('CERTIFICATE_READBACK');
  await client.query("UPDATE opencrawl_online_coverage_encounters SET outcome='certified',deferred_operation=NULL WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND kind<>'immutable'",[...scope,value.key]);
 }
 async function defer(key:string){text(key,8192);inScope(key);return transaction(async client=>{
  await boundIn(client);const row=(await client.query("SELECT operation_id FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND state<>'notApplied' ORDER BY revision DESC LIMIT 1",[...scope,key])).rows[0];if(!row)fail('BASELINE_REQUIRED');
  const result=await client.query("UPDATE opencrawl_online_coverage_encounters SET outcome=CASE WHEN EXISTS(SELECT 1 FROM opencrawl_online_coverage_certificates c WHERE c.namespace=$1 AND c.epoch=$2 AND c.source_id=$3 AND c.source_key=$4) THEN 'certified' ELSE 'deferred' END,deferred_operation=$5 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 AND kind<>'immutable'",[...scope,key,row.operation_id]);if(result.rowCount!==1)fail('ENCOUNTER_MISSING');
 });}
 async function completePage(input:OnlineCoveragePage){
  const frozen=decodePage({shard:input.shard,page_number:input.number,request_hash:digest(input.cursor),request_cursor:input.cursor,next_cursor:input.next,page_limit:input.limit,entries:input.entries,page_hash:input.hash,complete:input.complete});
  return transaction(async client=>{
   await boundIn(client);const walk=(await client.query('SELECT next_page::text,cursor,complete,page_chain,encountered::text FROM opencrawl_online_coverage_traversals WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 FOR UPDATE',[...scope,frozen.shard])).rows[0];const page=await lookupIn(client,frozen.shard,frozen.cursor);if(!walk||!page||page.hash!==frozen.hash)fail('PAGE_CHANGED');if(page.complete)return page;
   if(walk.complete||walk.next_page!==page.number||walk.cursor!==page.cursor)fail('MISSING_PREDECESSOR_PAGE');
   for(const v of page.entries)if(owner(v.key)===page.shard){
    const encountered=(await client.query('SELECT kind,domain,scope_hash,native_binding_hash,outcome,deferred_operation,page_number::text FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,v.key])).rows[0];if(!encountered||encountered.page_number!==page.number||encountered.kind!==v.kind||encountered.domain!==v.domain||encountered.scope_hash!==v.scopeHash||(encountered.native_binding_hash??undefined)!==v.nativeBindingHash)fail('ENCOUNTER_CHANGED');
    if(v.kind==='immutable')continue;const proof=await readIn(client,v.key);if(proof){if(proof.kind!==v.kind||proof.domain!==v.domain||proof.scopeHash!==v.scopeHash||proof.nativeBindingHash!==v.nativeBindingHash)fail('CERTIFICATE_SCOPE_CHANGED');await client.query("UPDATE opencrawl_online_coverage_encounters SET outcome='certified',deferred_operation=NULL WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4",[...scope,v.key]);continue;}
    if(encountered.outcome!=='deferred'||!(await client.query("SELECT 1 FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND operation_id=$4 AND source_key=$5 AND state<>'notApplied'",[...scope,encountered.deferred_operation,v.key])).rows.length)fail('PAGE_EFFECT_MISSING');
   }
   const owned=page.entries.filter(v=>owner(v.key)===page.shard).length,chain=digest([walk.page_chain,page.number,page.hash]);sequence(walk.encountered);
   const updated=await client.query('UPDATE opencrawl_online_coverage_traversals SET next_page=next_page+1,cursor=$5,complete=$6,page_chain=$7,encountered=encountered+$8 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 AND next_page=$9 AND cursor IS NOT DISTINCT FROM $10',[...scope,page.shard,page.next,page.next===null,chain,owned,page.number,page.cursor]);if(updated.rowCount!==1)fail('PAGE_CAS_FAILED');
   await client.query('UPDATE opencrawl_online_coverage_pages SET complete=true WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 AND page_number=$5',[...scope,page.shard,page.number]);return {...page,complete:true};
  });
 }
 async function nativeKeysPageIn(client:PoolClient,{after,limit}:{after:string;limit:number}){
  if(after)text(after,8192);if(!Number.isInteger(limit)||limit<1||limit>64)fail('INVALID_PAGE_REQUEST');await boundIn(client);
  const keys:string[]=[];
  for(const table of ['opencrawl_online_coverage_certificates','opencrawl_online_coverage_encounters']){
   const rows=(await client.query(`SELECT source_key FROM ${table} WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND kind='preserved-native' AND source_key>$4 COLLATE "C" ORDER BY source_key COLLATE "C" LIMIT $5`,[...scope,after,limit])).rows;
   if(rows.length>limit)fail('INVALID_PAGE');for(const row of rows){text(row.source_key,8192);keys.push(row.source_key);}
  }
  return [...new Set(keys)].sort(ordered).slice(0,limit);
 }
 /** Read-only source-local traversal verification. The outer snapshot reader
  * owns transaction identity and invalidation; no completion flag is trusted. */
 async function beginTraversalSnapshotIn(client:PoolClient){
  await boundIn(client);
  const walks=(await client.query('SELECT shard,next_page::text,cursor,complete,page_chain,encountered::text FROM opencrawl_online_coverage_traversals WHERE namespace=$1 AND epoch=$2 AND source_id=$3 ORDER BY shard LIMIT 257',scope)).rows;
  if(walks.length!==shards)fail('INCOMPLETE_TRAVERSAL');
  for(const [i,row] of walks.entries()){sequence(row.next_page);sequence(row.encountered);if(row.shard!==i||row.next_page==='0'||row.cursor!==null||row.complete!==true||!sha.test(row.page_chain))fail('INCOMPLETE_TRAVERSAL');}
  for(const outcome of ['pending','deferred'])if((await client.query('SELECT 1 FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND outcome=$4 LIMIT 1',[...scope,outcome])).rows.length)fail('UNRESOLVED_ENCOUNTER');
  let current=0,number=0n,request:string|null=null,chain=digest([identity,0]),encountered=0n,pages=0n,total=0n,summary=digest([identity,'verified-traversal-v1']);
  let pendingPage:OnlineCoveragePage|null=null,entryOffset=0;
  return {async next(limit=64){
   if(!Number.isInteger(limit)||limit<1||limit>64)fail('INVALID_PAGE_REQUEST');
   if(current===shards)return {complete:true as const,entries:[] as OnlineCoverageEntry[],hash:summary,pages:pages.toString(),encountered:total.toString()};
   const walk=walks[current]!;
   if(!pendingPage){const row=(await client.query(`SELECT ${pageColumns} FROM opencrawl_online_coverage_pages WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 AND page_number=$5`,[...scope,current,number.toString()])).rows[0];
    if(!row)fail('MISSING_PAGE');pendingPage=decodePage(row);
    if(!pendingPage.complete||pendingPage.cursor!==request||pendingPage.number!==number.toString()||pendingPage.entries.some((v,i)=>i>0&&ordered(pendingPage!.entries[i-1]!.key,v.key)>=0)||Buffer.byteLength(JSON.stringify(pendingPage.entries))>1048576||pendingPage.next!==null&&pendingPage.next===request)fail('PAGE_CHAIN_CHANGED');
   }
   const page=pendingPage,entries=page.entries.slice(entryOffset,entryOffset+limit);
   for(const v of entries)if(owner(v.key)===current){
    const actual=await encounterIn(client,v.key);if(!actual||actual.shard!==current||actual.page!==page.number||!isDeepStrictEqual(actual.entry,v))fail('ENCOUNTER_CHANGED');
    if(v.kind!=='immutable'){const certificate=await readIn(client,v.key);if(!certificate||!isDeepStrictEqual(entry(certificate),v))fail('CERTIFICATE_SCOPE_CHANGED');}
    encountered++;
   }
   entryOffset+=entries.length;
   if(entryOffset<page.entries.length)return {complete:false,entries,hash:summary,pages:pages.toString(),encountered:total.toString()};
   pendingPage=null;entryOffset=0;
   chain=digest([chain,page.number,page.hash]);number++;pages++;request=page.next;
   if(page.next===null){
    if(number.toString()!==walk.next_page||chain!==walk.page_chain||encountered.toString()!==walk.encountered)fail('TRAVERSAL_CHAIN_CHANGED');
    if((await client.query('SELECT 1 FROM opencrawl_online_coverage_pages WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 AND page_number>=$5 LIMIT 1',[...scope,current,number.toString()])).rows.length)fail('EXTRA_PAGE');
    summary=digest([summary,current,number.toString(),chain,encountered.toString()]);total+=encountered;current++;number=0n;request=null;encountered=0n;chain=digest([identity,current]);
   }else if(number>=BigInt(walk.next_page))fail('MISSING_FINAL_PAGE');
   return {complete:current===shards,entries,hash:summary,pages:pages.toString(),encountered:total.toString()};
  }};
 }
 async function encounterIn(client:PoolClient,key:string){
  text(key,8192);inScope(key);await boundIn(client);
  const row=(await client.query('SELECT shard,page_number::text,kind,domain,scope_hash,native_binding_hash,outcome,deferred_operation FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,key])).rows[0];
  if(!row)return null;sequence(row.page_number);
  const value=entry({key,kind:row.kind,domain:row.domain,scopeHash:row.scope_hash,...(row.native_binding_hash===null?{}:{nativeBindingHash:row.native_binding_hash})});
  if(row.shard!==owner(key)||row.outcome!==(value.kind==='immutable'?'immutable':'certified')||row.deferred_operation!==null)fail('ENCOUNTER_NOT_CERTIFIED');
  const pageRow=(await client.query(`SELECT ${pageColumns} FROM opencrawl_online_coverage_pages WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND shard=$4 AND page_number=$5`,[...scope,row.shard,row.page_number])).rows[0];
  if(!pageRow)fail('ENCOUNTER_PAGE_MISSING');const page=decodePage(pageRow);
  if(!page.complete||page.entries.filter(v=>v.key===key&&isDeepStrictEqual(v,value)).length!==1)fail('ENCOUNTER_PAGE_CHANGED');
  return {entry:value,shard:row.shard as number,page:row.page_number as string};
 }
 async function keysPageIn(client:PoolClient,{after,limit}:{after:string;limit:number}){
  if(after)text(after,8192);if(!Number.isInteger(limit)||limit<1||limit>64)fail('INVALID_PAGE_REQUEST');await boundIn(client);const all:string[]=[];
  for(const table of ['opencrawl_online_coverage_encounters','opencrawl_online_coverage_certificates']){
   const rows=(await client.query(`SELECT source_key FROM ${table} WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key>$4 COLLATE "C" ORDER BY source_key COLLATE "C" LIMIT $5`,[...scope,after,limit])).rows;
   if(rows.length>limit)fail('INVALID_PAGE');for(const row of rows){text(row.source_key,8192);inScope(row.source_key);all.push(row.source_key);}
  }return [...new Set(all)].sort(ordered).slice(0,limit);
 }
 async function nextDeferred(){return transaction(async client=>{
  await boundIn(client);const ticket=(await client.query('UPDATE opencrawl_online_coverage_bindings SET repair_counter=repair_counter+1 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 RETURNING repair_counter::text',scope)).rows[0];sequence(ticket.repair_counter);
  const row=(await client.query("SELECT source_key FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND outcome='deferred' ORDER BY attempt,source_key COLLATE \"C\" LIMIT 1 FOR UPDATE SKIP LOCKED",scope)).rows[0];if(!row)return null;
  await client.query('UPDATE opencrawl_online_coverage_encounters SET attempt=$5 WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4',[...scope,row.source_key,ticket.repair_counter]);return row.source_key as string;
 });}
 async function status(){return transaction(async client=>{
  await boundIn(client);const rows=(await client.query('SELECT shard,next_page::text,cursor,complete,page_chain,encountered::text FROM opencrawl_online_coverage_traversals WHERE namespace=$1 AND epoch=$2 AND source_id=$3 ORDER BY shard',scope)).rows;if(rows.length>shards)fail('EXTRA_SHARD');
  for(const row of rows){if(!Number.isInteger(row.shard)||row.shard<0||row.shard>=shards||typeof row.complete!=='boolean'||!sha.test(row.page_chain))fail('INVALID_TRAVERSAL');sequence(row.next_page);sequence(row.encountered);cursor(row.cursor);}
  const unresolved=(await client.query("SELECT 1 FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND outcome='pending' LIMIT 1",scope)).rows.length>0||(await client.query("SELECT 1 FROM opencrawl_online_coverage_encounters WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND outcome='deferred' LIMIT 1",scope)).rows.length>0;
  return {identity,traversalComplete:rows.length===shards&&rows.every((row,i)=>row.shard===i&&row.complete),unresolvedEncounter:unresolved,shards:rows.map(row=>({shard:row.shard,pages:row.next_page,encountered:row.encountered,chain:row.page_chain,complete:row.complete,cursor:row.cursor})),runtimeAdmission:false as const};
 });}
 return {binding,identity,ready,getPage,stagePage,completePage,recordIn,readIn,defer,nextDeferred,status,nativeKeysPageIn,beginTraversalSnapshotIn,encounterIn,keysPageIn};
}
