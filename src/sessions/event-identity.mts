import type {Principal, SessionIdentity, SessionBatch, SessionEvent, EventReservationOptions, SourceOptions, ObjectStore, StorePage, StoreVersion} from './types.mjs';
import {parseJson, isSessionHarness, SESSION_HARNESSES} from './types.mjs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

export const digest=(bytes: string | Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const id=(value: unknown)=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const hex=(value: unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function fail(status: number,message: string,detail: Record<string, unknown>={}): never {throw Object.assign(new Error(message),{status,permanent:status!==503,...detail});}
export const MAX_EVENT_LEDGER_BYTES=16*1024*1024;
const MAX_STORED_BATCH_BYTES=17*1024*1024,MAX_SOURCE_BATCHES=10000;

/** Principal comes from the runtime adapter, never the request payload. */
export function sessionScope(principal: Principal | null | undefined) {
 if(!principal||!id(principal.tenantId)||!id(principal.userId))fail(401,'Authentication required');
 if(principal.captureAccess!==undefined&&principal.captureAccess!=='write')fail(403,'Unknown capture access');
 return `tenants/${digest(principal.tenantId)}/users/${digest(principal.userId)}`;
}
export function sourceBatchIdentity(prefix: string,key: string) {
 if(typeof key!=='string'||!key.startsWith(prefix+'/'))return null;
 const hash='[a-f0-9]{64}';
 const match=new RegExp(`^tenants/(${hash})/users/(${hash})/(${SESSION_HARNESSES.join('|')})/(${hash})/(${hash})/(${hash})\\.json\\.gz$`).exec(key.slice(prefix.length+1));
 return match?{tenantHash:match[1],userHash:match[2],harness:match[3],installationHash:match[4],sessionHash:match[5],batchId:match[6]}:null;
}
function location({prefix,principal,harness,installationId,sessionId}: SessionIdentity) {
 if(typeof prefix!=='string'||!prefix||prefix.split('/').some(part=>!part||part==='.'||part==='..'))fail(400,'Invalid session prefix');
 const scope=sessionScope(principal);
 if(!isSessionHarness(harness)||!id(installationId)||!id(sessionId))fail(400,'Invalid session identity');
 const identity=digest(JSON.stringify([principal.tenantId,principal.userId,harness,installationId,sessionId]));
 const source=`${prefix}/${scope}/${harness}/${digest(installationId)}/${digest(sessionId)}/`;
 return {identity,source,key:source+'event-identities-v1.json'};
}
function eventHash(event: SessionEvent) {
 if(!event||!id(event.id)||typeof event.kind!=='string')fail(400,'Invalid events');
 const hash=createHash('sha256');
 function visit(value: unknown,depth=0): void {
  if(depth>128)fail(400,'Event structure exceeds supported depth');
  if(value===null||typeof value!=='object'){hash.update(JSON.stringify(value));return;}
  if(Array.isArray(value)){hash.update('[');for(let i=0;i<value.length;i++){if(i)hash.update(',');visit(value[i],depth+1);}hash.update(']');return;}
  hash.update('{');let first=true;
  for(const key of Object.keys(value).sort()){if(!first)hash.update(',');first=false;hash.update(JSON.stringify(key)+':');visit((value as Record<string, unknown>)[key],depth+1);}
  hash.update('}');
 }
 visit(event);return hash.digest('hex');
}
function fingerprints(events: SessionEvent[],conflicts=new Set<string>()) {
 if(!Array.isArray(events)||!events.length||events.length>1000)fail(400,'Invalid events');
 const result=new Map<string, string>();
 for(const event of events){const hash=eventHash(event),key=digest(event.id);if(result.has(key)&&result.get(key)!==hash)conflicts.add(key);else result.set(key,hash);}
 return result;
}
function conflict(conflicts: Set<string>) {fail(409,'Event ID already reserved for different content',{code:'SESSION_EVENT_ID_CONFLICT',conflictCount:conflicts.size,conflictIds:[...conflicts].sort().slice(0,100)});}
function merge(target: Map<string, string>,incoming: Map<string, string>,conflicts: Set<string>) {
 for(const [key,hash] of incoming){if(target.has(key)&&target.get(key)!==hash)conflicts.add(key);else target.set(key,hash);}
}
function capacity(identity: string,count: number) {
 const size=Buffer.byteLength(JSON.stringify({schemaVersion:1,identity,events:{}}))+count*134-(count?1:0);
 if(size>MAX_EVENT_LEDGER_BYTES)fail(413,'Session event identity capacity exceeded; start a new session');
}
function encode(identity: string,events: Map<string, string>) {
 capacity(identity,events.size);
 return Buffer.from(JSON.stringify({schemaVersion:1,identity,events:Object.fromEntries(events)}));
}
function parse<T>(bytes: Uint8Array,label: string): T {
 try{return parseJson<T>(bytes);}catch{fail(409,'Invalid '+label);}
}
async function readLedger(store: ObjectStore,where: ReturnType<typeof location>) {
 if(typeof store.readVersion!=='function'||typeof store.compareAndSet!=='function')fail(503,'Session capture requires conditional object storage');
 const value=await store.readVersion(where.key,{maxBytes:MAX_EVENT_LEDGER_BYTES});
 if(!value.data){if(value.version!==null)fail(503,'Invalid event identity storage version');return {version:null,events:null};}
 if(value.data.length>MAX_EVENT_LEDGER_BYTES)fail(413,'Session event identity capacity exceeded');
 if(value.version===null||value.version===undefined)fail(503,'Invalid event identity storage version');
 const ledger=parse<{schemaVersion: number; identity: string; events: Record<string, string>}>(value.data,'session event identity ledger');
 if(ledger?.schemaVersion!==1||ledger.identity!==where.identity||!ledger.events||typeof ledger.events!=='object'||Array.isArray(ledger.events))fail(409,'Session event identity ledger mismatch');
 const entries=Object.entries(ledger.events);
 if(entries.some(([key,hash])=>!hex(key)||!hex(hash)))fail(409,'Invalid session event identity ledger');
 return {version:value.version,events:new Map(entries)};
}
function checkedBatch(options: SessionIdentity,key: string,bytes: Uint8Array | null) {
 if(!bytes)fail(503,'Session source object unavailable');
 const batch=decodeBatch(bytes),{principal}=options;
 const identity=sourceBatchIdentity(options.prefix,key);
 if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(principal.userId)||
  batch?.schemaVersion!==1||batch.owner?.tenantId!==principal.tenantId||batch.owner?.userId!==principal.userId||
  batch.harness!==identity.harness||!id(batch.installationId)||!id(batch.sessionId)||digest(batch.installationId)!==identity.installationHash||digest(batch.sessionId)!==identity.sessionHash||
  batch.harness!==options.harness||batch.installationId!==options.installationId||batch.sessionId!==options.sessionId)fail(409,'Stored batch does not match its authorized session');
 return batch;
}
function decodeBatch(bytes: Uint8Array) {
 let raw;try{raw=gunzipSync(bytes,{maxOutputLength:MAX_STORED_BATCH_BYTES});}catch{fail(409,'Invalid compressed session batch');}
 return parse<SessionBatch>(raw,'stored session batch');
}
function inventoryPage(page: StorePage) {
 if(!Array.isArray(page?.keys)||page.keys.length>100||page.nextToken!=null&&(typeof page.nextToken!=='string'||page.nextToken.length>8192))fail(503,'Invalid session source inventory');
}
async function historical(options: SessionIdentity & {store: ObjectStore},where: ReturnType<typeof location>) {
 const {store}=options;
 if(typeof store.listPage!=='function')fail(503,'Session capture requires source inventory support');
 const events=new Map<string, string>(),conflicts=new Set<string>(),seen=new Set<string>();let cursor: string | null | undefined,batches=0,pages=0;
 do {
  if(++pages>1000)fail(413,'Session identity bootstrap exceeds inventory page limit');
  const page=await store.listPage(where.source,{continuationToken:cursor,maxKeys:100});
  inventoryPage(page);
  for(const key of page.keys) {
   if(typeof key!=='string'||!key.startsWith(where.source))fail(409,'Session source inventory outside scope');
   if(!/^[a-f0-9]{64}\.json\.gz$/.test(key.slice(where.source.length)))continue;
   if(++batches>MAX_SOURCE_BATCHES)fail(413,'Session identity bootstrap exceeds source inventory limit');
   const bytes=await store.get(key,{maxBytes:MAX_STORED_BATCH_BYTES}),batch=checkedBatch(options,key,bytes);
   merge(events,fingerprints(batch.events,conflicts),conflicts);
   // Fail while reading rather than retain an unbounded historical session.
   capacity(where.identity,events.size);
  }
  cursor=page.nextToken;
  if(cursor){if(seen.has(cursor))fail(503,'Session inventory cursor did not advance');seen.add(cursor);}
 }while(cursor);
 return {events,conflicts,batches};
}

/** Atomically reserves the whole batch before publication. A failed source write
 * leaves reservations behind; retry the same events, never reuse an ID to edit.
 * Old writers must be drained before the first historical bootstrap.
 */
export async function reserveSessionEvents(options: EventReservationOptions) {
 const where=location(options),inputConflicts=new Set<string>(),incoming=fingerprints(options.events,inputConflicts);
 if(inputConflicts.size)conflict(inputConflicts);
 let initial: Awaited<ReturnType<typeof historical>> | undefined;
 for(let attempt=0;attempt<8;attempt++) {
  const ledger=await readLedger(options.store,where);
  if(!ledger.events){initial??=await historical(options,where);if(initial.conflicts.size)conflict(initial.conflicts);}
  const events=new Map(ledger.events||initial!.events),conflicts=new Set<string>();
  merge(events,incoming,conflicts);if(conflicts.size)conflict(conflicts);
  if(ledger.events&&events.size===ledger.events.size)return {reservedEvents:events.size};
  const bytes=encode(where.identity,events);
  if(await options.store.compareAndSet(where.key,ledger.version,bytes))return {reservedEvents:events.size};
 }
 fail(503,'Session event identity ledger busy; retry the same batch');
}

/** Audits every accepted batch in one trusted session, including already-indexed
 * historical batches. initialize=true reserves the audited IDs without deleting
 * raw data or changing search documents. Results contain counts and hashes only.
 */
export async function auditSessionEventIdentities(options: SessionIdentity & {store: ObjectStore; initialize?: boolean}) {
 sessionScope(options.principal);
 if(options.principal.captureAccess==='write')fail(403,'Capture credentials cannot audit sessions');
 const where=location(options),source=await historical(options,where);
 for(let attempt=0;attempt<8;attempt++) {
  const ledger=await readLedger(options.store,where),events=new Map(ledger.events||[]),conflicts=new Set(source.conflicts);
  merge(events,source.events,conflicts);
  const report={sessionIdentity:where.identity,batches:source.batches,events:source.events.size,reservedEvents:events.size,conflicts:conflicts.size,conflictIds:[...conflicts].sort().slice(0,100),initialized:false};
  if(conflicts.size||!options.initialize)return report;
  const bytes=encode(where.identity,events);
  if(ledger.events&&events.size===ledger.events.size||await options.store.compareAndSet(where.key,ledger.version,bytes))return {...report,initialized:true};
 }
 fail(503,'Session event identity audit busy; retry');
}

/** Portable whole-source audit. The adapter supplies one fixed principal or a
 * trusted stored-owner resolver, exactly as the indexing pipeline does.
 */
export async function auditSessionEventSource({store,prefix,principal,resolvePrincipal,initialize=false}: SourceOptions) {
 if(Boolean(principal)===Boolean(resolvePrincipal))fail(400,'Supply a fixed principal or trusted scope resolver');
 if(principal){sessionScope(principal);if(principal.captureAccess==='write')fail(403,'Capture credentials cannot audit sessions');}
 if(typeof prefix!=='string'||!prefix||prefix.split('/').some(part=>!part||part==='.'||part==='..'))fail(400,'Invalid session prefix');
 const sourcePrefix=prefix+'/'+(principal?sessionScope(principal)+'/':'tenants/'),seen=new Set(),cursors=new Set();
 const report={sessions:0,batches:0,events:0,reservedEvents:0,conflicts:0,initialized:0,conflictIds:[] as {sessionIdentity: string; eventIdentity: string}[]};let cursor: string | null | undefined,pages=0;
 do {
  if(++pages>10000)fail(413,'Session identity audit exceeds inventory page limit');
  const page=await store.listPage(sourcePrefix,{continuationToken:cursor,maxKeys:100});
  inventoryPage(page);
  for(const key of page.keys) {
   if(typeof key!=='string'||!key.startsWith(sourcePrefix))fail(409,'Session source inventory outside scope');
   if(!sourceBatchIdentity(prefix,key))continue;
   const sessionPrefix=key.slice(0,key.lastIndexOf('/')+1);if(seen.has(sessionPrefix))continue;
   if(seen.size>=100000)fail(413,'Session identity audit exceeds session limit');seen.add(sessionPrefix);
   const bytes=await store.get(key,{maxBytes:MAX_STORED_BATCH_BYTES});if(!bytes)fail(503,'Session source object unavailable');
   const batch=decodeBatch(bytes),owner=principal||await resolvePrincipal!({key,batch});
   const options={store,prefix,principal:owner,harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,initialize};
   sessionScope(owner);checkedBatch(options,key,bytes);
   const result=await auditSessionEventIdentities(options);
   report.sessions++;for(const field of (['batches','events','reservedEvents','conflicts'] as const))report[field]+=result[field];if(result.initialized)report.initialized++;
   for(const eventIdentity of result.conflictIds)if(report.conflictIds.length<100)report.conflictIds.push({sessionIdentity:result.sessionIdentity,eventIdentity});
  }
  cursor=page.nextToken;if(cursor){if(cursors.has(cursor))fail(503,'Session inventory cursor did not advance');cursors.add(cursor);}
 }while(cursor);
 return report;
}
