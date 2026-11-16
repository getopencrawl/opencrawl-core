import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';

/** Nonsecret routing facts only. The owning registry adapter retains historical
 * physical routes; it does not grant current connector or runtime access. */
export interface OnlineConnectionScope {
 environment:'production'|'staging'|'selfhost';tenantId:string;userId:string;
 connectionId:string;provider:string;bucket:string;prefix:string;workspace:string|null;
}
export type OnlineConnectionScopeLookup={bucket:string;connectionId:string}|{bucket:string;prefix:string};
export interface OnlineConnectionScopeReader {
 readonly binding:Readonly<{namespace:string;epoch:string;verifierId:string;bindingHash:string}>;
 /** Same real transaction client, no pool escape. The reader must return at most
  * two matches; zero and ambiguous routing are both refused by the consumer. */
 readIn(client:PoolClient,lookup:Readonly<OnlineConnectionScopeLookup>):Promise<readonly OnlineConnectionScope[]>;
}
export interface OnlineConnectionScopePinsOptions {
 database:ApplicationDatabase;epoch:string;sourceId:string;bucket:string;reader:OnlineConnectionScopeReader;
 hasTenantIn(client:PoolClient,tenantId:string):Promise<boolean>;
}
const sha=/^[a-f0-9]{64}$/,uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(reason:string):never{throw Object.assign(new Error('Online connection scope: '+reason),{code:'ONLINE_CONNECTION_SCOPE_INVALID'});}
function text(value:unknown,max:number):asserts value is string{if(typeof value!=='string'||!value||Buffer.byteLength(value)>max||/[\u0000-\u001f\u007f]/.test(value))fail('invalid bounded text');}
function fields(value:object,names:string[]){if(Object.keys(value).sort().join(',')!==names.sort().join(','))fail('unexpected fields');}
function path(value:unknown):asserts value is string{text(value,8192);if(value.split('/').some(part=>!part||part==='.'||part==='..'))fail('invalid physical prefix');}
export function normalizeOnlineConnectionScope(input:OnlineConnectionScope):Readonly<OnlineConnectionScope>{
 if(!input||typeof input!=='object')fail('missing routing facts');fields(input,['environment','tenantId','userId','connectionId','provider','bucket','prefix','workspace']);
 if(!['production','staging','selfhost'].includes(input.environment)||!/^(?:org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/.test(input.tenantId)||!/^user_[A-Za-z0-9]+$/.test(input.userId))fail('invalid owner');
 text(input.tenantId,200);text(input.userId,200);text(input.connectionId,200);text(input.provider,200);text(input.bucket,255);path(input.prefix);
 if(!/^[A-Za-z0-9_:-]+$/.test(input.connectionId)||!/^[A-Za-z0-9_-]+$/.test(input.provider))fail('invalid connection identity');
 if(input.workspace!==null){text(input.workspace,200);if(!/^[A-Za-z0-9_:-]+$/.test(input.workspace))fail('invalid workspace');}
 return Object.freeze({environment:input.environment,tenantId:input.tenantId,userId:input.userId,connectionId:input.connectionId,provider:input.provider,bucket:input.bucket,prefix:input.prefix,workspace:input.workspace});
}
export function bindOnlineConnectionScopeReader(reader:OnlineConnectionScopeReader,namespace:string,epoch:string){
 if(!reader||typeof reader.readIn!=='function'||!reader.binding)fail('reader required');
 fields(reader.binding,['namespace','epoch','verifierId','bindingHash']);const {verifierId,bindingHash}=reader.binding;text(namespace,2048);text(verifierId,512);
 if(!uuid.test(epoch)||reader.binding.namespace!==namespace||reader.binding.epoch!==epoch||!sha.test(bindingHash))fail('reader binding differs');
 return Object.freeze({binding:Object.freeze({namespace,epoch,verifierId,bindingHash}),readIn:reader.readIn.bind(reader)});
}

/** Durable migration routing pins. Both source-key mapping and physical-prefix
 * ownership survive deletions/reconnects. All data operations use the supplied
 * journal/projection client; ready() is explicit schema preparation only. */
export function createOnlineConnectionScopePins({database,epoch,sourceId,bucket,reader,hasTenantIn}:OnlineConnectionScopePinsOptions){
 const namespace=database.namespace,owner=bindOnlineConnectionScopeReader(reader,namespace,epoch),scope=[namespace,epoch,sourceId];text(sourceId,2048);text(bucket,255);
 if(typeof hasTenantIn!=='function')fail('tenant verifier required');const checkTenant=hasTenantIn;
 const readerHash=hash(owner.binding),binding=Object.freeze({...owner.binding,sourceId,bucket,readerHash});
 const columns='reader_hash,scope_hash,selector_kind,environment,tenant_id,user_id,connection_id,provider,bucket,raw_prefix,workspace';
 let preparing:Promise<void>|undefined;
 async function ready(){preparing??=database.transaction(async client=>{
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:online-connection-scopes:schema',0))");
  await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_online_connection_scope_pins(namespace text NOT NULL,epoch uuid NOT NULL,source_id text NOT NULL,source_key text COLLATE "C" NOT NULL,reader_hash text NOT NULL CHECK(reader_hash~'^[a-f0-9]{64}$'),scope_hash text NOT NULL CHECK(scope_hash~'^[a-f0-9]{64}$'),selector_kind text NOT NULL CHECK(selector_kind IN ('connection','prefix')),environment text NOT NULL CHECK(environment IN ('production','staging','selfhost')),tenant_id text NOT NULL,user_id text NOT NULL,connection_id text NOT NULL,provider text NOT NULL,bucket text NOT NULL,raw_prefix text,workspace text,CHECK((selector_kind='connection' AND raw_prefix IS NULL AND workspace IS NULL) OR (selector_kind='prefix' AND raw_prefix IS NOT NULL)),PRIMARY KEY(namespace,epoch,source_id,source_key))`);
  await ensureSchemaIndex(client,{table:'opencrawl_online_connection_scope_pins',name:'opencrawl_online_connection_scope_prefix',keys:['namespace','epoch','source_id','bucket','raw_prefix','scope_hash']});
 }).catch(error=>{preparing=undefined;throw error;});await preparing;}
 function lookup(input:OnlineConnectionScopeLookup){
  if(!input||typeof input!=='object'||input.bucket!==bucket)fail('lookup source differs');
  if('connectionId' in input){fields(input,['bucket','connectionId']);text(input.connectionId,200);if(!/^[A-Za-z0-9_:-]+$/.test(input.connectionId))fail('invalid connection selector');return Object.freeze({bucket,connectionId:input.connectionId});}
  fields(input,['bucket','prefix']);path(input.prefix);return Object.freeze({bucket,prefix:input.prefix});
 }
 function logicalOwner(value:OnlineConnectionScope){return {environment:value.environment,tenantId:value.tenantId,userId:value.userId,connectionId:value.connectionId,provider:value.provider,bucket:value.bucket};}
 function pinned(value:OnlineConnectionScope,kind:'connection'|'prefix'){return kind==='connection'?logicalOwner(value):value;}
 function decode(row:Record<string,unknown>){
  const kind=row.selector_kind;if(kind!=='connection'&&kind!=='prefix'||kind==='connection'&&(row.raw_prefix!==null||row.workspace!==null))fail('stored selector changed');
  // A connection pin deliberately omits physical routing: reconnect may select
  // another prefix/workspace for the same immutable logical owner.
  const value=normalizeOnlineConnectionScope({environment:row.environment,tenantId:row.tenant_id,userId:row.user_id,connectionId:row.connection_id,provider:row.provider,bucket:row.bucket,prefix:kind==='connection'?'validation-only':row.raw_prefix,workspace:row.workspace} as OnlineConnectionScope);
  const facts=pinned(value,kind),scopeHash=hash({format:1,binding,kind,scope:facts});if(row.reader_hash!==readerHash||row.scope_hash!==scopeHash)fail('stored routing pin changed');return {kind,facts,scopeHash};
 }
 async function resolveIn(client:PoolClient,input:{key:string;lookup:OnlineConnectionScopeLookup;write:boolean}){
  const key=input.key,query=lookup(input.lookup),write=input.write;text(key,8192);if(typeof write!=='boolean')fail('invalid operation');
  const found=await owner.readIn(client,query);if(!Array.isArray(found)||found.length!==1)fail('routing must have exactly one match');
  const value=normalizeOnlineConnectionScope(found[0]);
  if(value.bucket!==bucket||('connectionId' in query?value.connectionId!==query.connectionId:value.prefix!==query.prefix)||!await checkTenant(client,value.tenantId))fail('route or enrolled owner differs');
  const kind='connectionId' in query?'connection':'prefix',facts=pinned(value,kind),scopeHash=hash({format:1,binding,kind,scope:facts});
  if(write){
   // Different keys can arrive concurrently. Serialize on the physical prefix
   // before refusing any attempt to give it another owner or connection.
   if(kind==='prefix'){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['online-connection-route',...scope,bucket,value.prefix])]);
   const prior=(await client.query('SELECT DISTINCT scope_hash FROM opencrawl_online_connection_scope_pins WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND bucket=$4 AND raw_prefix=$5 LIMIT 2',[...scope,bucket,value.prefix])).rows;
   if(prior.some(row=>row.scope_hash!==scopeHash))fail('physical prefix was reassigned');}
   await client.query(`INSERT INTO opencrawl_online_connection_scope_pins(namespace,epoch,source_id,source_key,reader_hash,scope_hash,selector_kind,environment,tenant_id,user_id,connection_id,provider,bucket,raw_prefix,workspace) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,[...scope,key,readerHash,scopeHash,kind,value.environment,value.tenantId,value.userId,value.connectionId,value.provider,bucket,kind==='prefix'?value.prefix:null,kind==='prefix'?value.workspace:null]);
  }
  const row=(await client.query(`SELECT ${columns} FROM opencrawl_online_connection_scope_pins WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4`,[...scope,key])).rows[0];
  if(!row)return null;const stored=decode(row);if(stored.kind!==kind||stored.scopeHash!==scopeHash||!isDeepStrictEqual(stored.facts,facts))fail('source key routing was reassigned');return Object.freeze({scope:value,scopeHash});
 }
 return Object.freeze({binding,readerBinding:owner.binding,ready,resolveIn});
}
