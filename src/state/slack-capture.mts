import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import type {ConnectorBinding} from '../connectors/types.mjs';
import type {FileCatalog,MessageCatalog,FileCheckpoint,MessageCheckpoint,ReferenceCheckpoint} from '../connectors/capture-types.mjs';
import {digest,validateBinding} from '../connectors/scope.mjs';
import {sourcePaginationProgress} from '../connectors/workflow.mjs';

export type SlackCaptureKind='files-v1'|'messages-v1'|'message-references-v1';
export type SlackCatalogKind='files-v1'|'messages-v1';
export interface SlackCheckpoints {'files-v1':FileCheckpoint;'messages-v1':MessageCheckpoint;'message-references-v1':ReferenceCheckpoint}
export interface SlackCatalogs {'files-v1':FileCatalog;'messages-v1':MessageCatalog}
export type SlackLegacyValue=FileCatalog|MessageCatalog|FileCheckpoint|MessageCheckpoint|ReferenceCheckpoint;
export interface SlackCaptureState {
 readCatalog<K extends SlackCatalogKind>(binding:ConnectorBinding,kind:K):Promise<SlackCatalogs[K]|null>;
 mergeCatalog<K extends SlackCatalogKind>(binding:ConnectorBinding,kind:K,value:SlackCatalogs[K]):Promise<void>;
 readCheckpoint<K extends SlackCaptureKind>(binding:ConnectorBinding,kind:K,runId:string):Promise<{value:SlackCheckpoints[K];revision:string}|null>;
 saveCheckpoint<K extends SlackCaptureKind>(binding:ConnectorBinding,kind:K,runId:string,value:SlackCheckpoints[K],revision:string|null):Promise<string>;
 reserve(binding:ConnectorBinding,method:string,now:number,interval:number):Promise<{reserved:boolean;waitMs:number}>;
 defer(binding:ConnectorBinding,method:string,due:number):Promise<void>;
}
const id=z.string().regex(/^[A-Z][A-Z0-9]{1,100}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().nonnegative().safe();
const runIdSchema=z.string().regex(/^[A-Za-z0-9_-]{1,150}$/),cursor=z.string().max(10000);
const progress=z.strictObject({version:z.literal(1),anchor:z.string().min(1).max(10000),window:z.string().regex(/^[1-9][0-9]*$/).max(4096),distance:z.string().regex(/^(0|[1-9][0-9]*)$/).max(4096)});
const target={cursor,paginationProgress:progress.optional(),done:z.boolean(),error:z.string().max(100).optional()};
const channel=z.strictObject({...target,id}),thread=z.strictObject({...target,channel:id,ts:z.string().regex(/^\d{1,16}\.\d{1,6}$/)});
const file=z.strictObject({...target,id,channels:z.array(id),comments:z.record(z.string(),z.string())});
const due=z.record(z.string().regex(/^(conversations\.(list|history|replies|info)|files\.(list|info))$/),integer);
const common={version:z.literal(1),scope:hash,runId:runIdSchema,pages:integer,emitted:integer};
const schemas={
 'messages-v1':z.strictObject({...common,cutoff:integer,cursor,paginationProgress:progress.optional(),channels:z.record(id,channel),threads:z.record(z.string(),thread),priorChannels:z.array(id).optional(),listed:z.boolean(),nextDue:due,errors:z.array(z.strictObject({method:z.string(),channel:z.union([z.string(),z.number(),z.boolean()]).optional(),thread:z.union([z.string(),z.number(),z.boolean()]).optional(),code:z.string().max(100)}))}),
 'files-v1':z.strictObject({...common,cutoff:integer,cursor,paginationProgress:progress.optional(),channels:z.record(id,z.strictObject({id,page:integer,done:z.boolean(),error:z.string().max(100).optional()})),files:z.record(id,file),priorChannels:z.array(id),listed:z.boolean(),nextDue:integer,errors:z.array(z.strictObject({method:z.string(),id:z.string(),code:z.string().max(100)}))}),
 'message-references-v1':z.strictObject({...common,inputHash:hash,position:integer,nextDue:due,errors:z.array(z.strictObject({position:integer,method:z.string(),code:z.string().max(100)}))}),
};
const catalogSchemas={'messages-v1':z.strictObject({scope:hash,channels:z.array(id)}),'files-v1':z.strictObject({scope:hash,channels:z.array(id),files:z.record(id,z.array(id))})};
const conflict=()=>Object.assign(new Error('Slack capture checkpoint changed; retry the durable activity'),{status:409});
const scopeError=()=>Object.assign(new Error('Slack capture state scope mismatch'),{status:403,permanent:true});
const canonical=(value:unknown)=>JSON.parse(JSON.stringify(value));
interface Identity {prefix:string;scope:string}
interface Item {kind:string;key:string;ordinal:number;value:unknown}
interface CheckpointRow {metadata:Record<string,unknown>;revision:string}
function bindingIdentity(binding:ConnectorBinding):Identity {validateBinding(binding);if(binding.provider!=='slack')throw scopeError();return {prefix:binding.rawPrefix,scope:digest(binding)};}
function validateCheckpoint<K extends SlackCaptureKind>(kind:K,value:unknown):SlackCheckpoints[K]{
 const parsed=schemas[kind].parse(value);
 if('cursor' in parsed)sourcePaginationProgress(parsed.cursor||null,parsed.paginationProgress);
 if('channels' in parsed)for(const [key,item] of Object.entries(parsed.channels)){if(item.id!==key)throw scopeError();if('cursor' in item)sourcePaginationProgress(item.cursor||null,item.paginationProgress);}
 if('threads' in parsed)for(const [key,item] of Object.entries(parsed.threads)){if(key!==item.channel+':'+item.ts)throw scopeError();sourcePaginationProgress(item.cursor||null,item.paginationProgress);}
 if('files' in parsed)for(const [key,item] of Object.entries(parsed.files)){if(item.id!==key)throw scopeError();sourcePaginationProgress(item.cursor||null,item.paginationProgress);}
 return parsed as SlackCheckpoints[K];
}
function splitCheckpoint(value:FileCheckpoint|MessageCheckpoint|ReferenceCheckpoint){
 const metadata=canonical(value) as Record<string,unknown>,items:Item[]=[];
 for(const category of ['channels','threads','files'] as const){
  const rows=metadata[category] as Record<string,Record<string,unknown>>|undefined;delete metadata[category];
  if(!rows)continue;
  for(const [key,original] of Object.entries(rows)){
   const item={...original};
   if(category==='files'){
    for(const [index,channel] of (item.channels as string[]).entries())items.push({kind:'file-channel',key:JSON.stringify([key,channel]),ordinal:index,value:{file:key,channel}});
    for(const [comment,text] of Object.entries(item.comments as Record<string,string>))items.push({kind:'file-comment',key:JSON.stringify([key,comment]),ordinal:0,value:{file:key,id:comment,text}});
    delete item.channels;delete item.comments;
   }
   items.push({kind:category,key,ordinal:0,value:item});
  }
 }
 if(Array.isArray(metadata.priorChannels)){metadata.hasPriorChannels=true;for(const [index,value] of metadata.priorChannels.entries())items.push({kind:'prior-channel',key:String(index),ordinal:index,value});delete metadata.priorChannels;}
 for(const [index,value] of (metadata.errors as unknown[]).entries())items.push({kind:'error',key:String(index),ordinal:index,value});delete metadata.errors;
 if(Buffer.byteLength(JSON.stringify(metadata))>65536)throw new Error('Slack capture scalar metadata exceeds limit');
 return {metadata,items};
}
function joinCheckpoint(kind:SlackCaptureKind,metadata:Record<string,unknown>,items:Item[]){
 const value={...metadata,errors:[]} as Record<string,unknown>;
 if(kind!=='message-references-v1'){value.channels={};value[kind==='files-v1'?'files':'threads']={};}
 if(value.hasPriorChannels){value.priorChannels=[];delete value.hasPriorChannels;}
 for(const item of items){
  if(['channels','threads','files'].includes(item.kind)){
   (value[item.kind] as Record<string,unknown>)[item.key]=item.kind==='files'?{...item.value as object,channels:[],comments:{}}:item.value;
  }else if(item.kind==='prior-channel')(value.priorChannels as unknown[]).push(item.value);
  else if(item.kind==='error')(value.errors as unknown[]).push(item.value);
 }
 for(const item of items){
  if(item.kind==='file-channel'||item.kind==='file-comment'){
   const v=item.value as {file:string;channel?:string;id?:string;text?:string},file=(value.files as Record<string,Record<string,unknown>>)[v.file];
   if(!file)throw new Error('Slack capture child has no file');
   if(item.kind==='file-channel')(file.channels as string[]).push(v.channel!);else(file.comments as Record<string,string>)[v.id!]=v.text!;
  }
 }
 return validateCheckpoint(kind,value);
}

export function slackCaptureLegacyIdentity(key:string){
 const match=/^(raw\/v1\/source=slack\/workspace=[A-Za-z0-9_:-]{1,200}\/connection=[A-Za-z0-9_:-]{1,200}\/)capture\/(files-v1|messages-v1|message-references-v1)\/(?:(catalog\.json)|([A-Za-z0-9_-]{1,150})\/state\.json)$/.exec(key);
 if(!match||match[3]&&match[2]==='message-references-v1')throw new Error('Invalid legacy Slack capture state key');
 return {prefix:match[1],kind:match[2] as SlackCaptureKind,catalog:Boolean(match[3]),runId:match[4]};
}
function validateSlackLegacyValue(key:string,parsed:unknown):SlackLegacyValue{
 const source=slackCaptureLegacyIdentity(key),value=source.catalog?catalogSchemas[source.kind as SlackCatalogKind].parse(parsed):validateCheckpoint(source.kind,parsed);
 if(!source.catalog&&(value as FileCheckpoint|MessageCheckpoint|ReferenceCheckpoint).runId!==source.runId)throw scopeError();
 return value;
}
export function validateSlackCaptureLegacy(key:string,bytes:Uint8Array):SlackLegacyValue{return validateSlackLegacyValue(key,JSON.parse(Buffer.from(bytes).toString()));}
/** Catalog arrays are sets of observed identities, not progress cursors. Old
 * concurrent runs may publish a different order without losing history. */
export function normalizeSlackCaptureProjection(key:string,input:unknown):SlackLegacyValue{
 const source=slackCaptureLegacyIdentity(key),value=validateSlackLegacyValue(key,input);
 if(!source.catalog)return value;
 const catalog=value as FileCatalog|MessageCatalog;
 const ordered=(values:string[])=>{if(new Set(values).size!==values.length)throw new Error('Online Slack catalog contains duplicate revocation identities');return [...values].sort();};
 return 'files' in catalog?{scope:catalog.scope,channels:ordered(catalog.channels),files:Object.fromEntries(Object.entries(catalog.files).map(([file,channels])=>[file,ordered(channels)]))}:{scope:catalog.scope,channels:ordered(catalog.channels)};
}


/** Capture metadata is relational: one row per target, comment, share and error.
 * The scalar run record is bounded; a large catalog never rewrites one object.
 * Revision checks reject late activities, and pacing spans every run/worker. */
export function createPostgresSlackCapture(database:ApplicationDatabase):SlackCaptureState&{
 ready():Promise<void>;validateLegacy(key:string,bytes:Uint8Array):SlackLegacyValue;importLegacy(key:string,bytes:Uint8Array):Promise<void>;exportLegacy(key:string,scope?:string):Promise<unknown>;
 exportLegacyIn(client:PoolClient,key:string,scope?:string):Promise<SlackLegacyValue|null>;
 readProjectedLegacyIn(client:PoolClient,key:string,scope:string):Promise<SlackLegacyValue|null>;
 projectLegacyIn(client:PoolClient,key:string,value:SlackLegacyValue,binding:ConnectorBinding):Promise<void>;
}{
 let preparing:Promise<void>|undefined;
 const parameters=(identity:Identity)=>[database.namespace,identity.prefix,identity.scope];
 async function lock(client:PoolClient,identity:Identity){
  await client.query('INSERT INTO opencrawl_slack_scopes(namespace,raw_prefix,scope_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',parameters(identity));
  const {rows}=await client.query('SELECT scope_hash FROM opencrawl_slack_scopes WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 FOR UPDATE',parameters(identity));
  if(rows[0]?.scope_hash!==identity.scope)throw scopeError();
 }
 async function check(client:Pick<PoolClient,'query'>,identity:Identity){const {rows}=await client.query('SELECT scope_hash FROM opencrawl_slack_scopes WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3',parameters(identity));if(rows[0]&&rows[0].scope_hash!==identity.scope)throw scopeError();return Boolean(rows.length);}
 async function readCatalog<K extends SlackCatalogKind>(identity:Identity,kind:K):Promise<SlackCatalogs[K]|null>{
  return database.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return readCatalogIn(client,identity,kind);});
 }
 async function readCatalogIn<K extends SlackCatalogKind>(client:PoolClient,identity:Identity,kind:K):Promise<SlackCatalogs[K]|null>{
   if(!await check(client,identity))return null;
   if(!(await client.query('SELECT 1 FROM opencrawl_slack_catalogs WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4',[...parameters(identity),kind])).rowCount)return null;
   const {rows}=await client.query<{item_kind:string;item_key:string;ordinal:number;value:unknown}>('SELECT item_kind,item_key,ordinal,value FROM opencrawl_slack_catalog_items WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4 ORDER BY ordinal,item_key',[...parameters(identity),kind]);
   for(const row of rows){
    integer.parse(row.ordinal);
    if(row.item_kind==='channel'||row.item_kind==='file'){
     id.parse(row.item_key);if(row.value!==null||kind==='messages-v1'&&row.item_kind!=='channel')throw new Error('Invalid normalized Slack catalog item');
    }else if(row.item_kind==='file-share'&&kind==='files-v1'){
     const share=z.strictObject({file:id,channel:id}).parse(row.value);if(row.item_key!==JSON.stringify([share.file,share.channel]))throw new Error('Invalid normalized Slack catalog share');
    }else throw new Error('Invalid normalized Slack catalog item');
   }
   const result:FileCatalog={scope:identity.scope,channels:[],files:{}};
   for(const row of rows){if(row.item_kind==='channel')result.channels.push(row.item_key);if(row.item_kind==='file')result.files[row.item_key]=[];}
   for(const row of rows)if(row.item_kind==='file-share'){const share=row.value as {file:string;channel:string};if(!result.files[share.file])throw new Error('Slack catalog share has no file');result.files[share.file].push(share.channel);}
   return catalogSchemas[kind].parse(kind==='files-v1'?result:{scope:result.scope,channels:result.channels}) as SlackCatalogs[K];
 }
 async function mergeCatalog<K extends SlackCatalogKind>(identity:Identity,kind:K,input:SlackCatalogs[K]){
  const value=catalogSchemas[kind].parse(input);if(value.scope!==identity.scope)throw scopeError();
  return database.transaction(client=>mergeCatalogIn(client,identity,kind,value as SlackCatalogs[K]));
 }
 async function mergeCatalogIn<K extends SlackCatalogKind>(client:PoolClient,identity:Identity,kind:K,input:SlackCatalogs[K]){
  const value=catalogSchemas[kind].parse(input);if(value.scope!==identity.scope)throw scopeError();
   await lock(client,identity);
   await client.query('INSERT INTO opencrawl_slack_catalogs(namespace,raw_prefix,scope_hash,kind) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[...parameters(identity),kind]);
   const items:Item[]=value.channels.map((key,ordinal)=>({kind:'channel',key,ordinal,value:null}));
   if(kind==='files-v1')for(const [key,channels] of Object.entries((value as FileCatalog).files)){
    items.push({kind:'file',key,ordinal:0,value:null});
    channels.forEach((channel,ordinal)=>items.push({kind:'file-share',key:JSON.stringify([key,channel]),ordinal,value:{file:key,channel}}));
   }
   // Catalog identities are monotonic history needed to discover revocations.
   // Union concurrent captures; never replace a previously observed share.
   await client.query(`INSERT INTO opencrawl_slack_catalog_items(namespace,raw_prefix,scope_hash,kind,item_kind,item_key,ordinal,value)
    SELECT $1,$2,$3,$4,x.kind,x.key,x.ordinal+coalesce((SELECT max(ordinal)+1 FROM opencrawl_slack_catalog_items WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4 AND item_kind=x.kind),0),x.value
    FROM jsonb_to_recordset($5::jsonb) AS x(kind text,key text,ordinal integer,value jsonb)
    ON CONFLICT(namespace,raw_prefix,scope_hash,kind,item_kind,item_key) DO NOTHING`,[...parameters(identity),kind,JSON.stringify(items)]);
 }
 async function readCheckpoint<K extends SlackCaptureKind>(identity:Identity,kind:K,runId:string):Promise<{value:SlackCheckpoints[K];revision:string}|null>{
  runIdSchema.parse(runId);return database.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return readCheckpointIn(client,identity,kind,runId);});
 }
 async function readCheckpointIn<K extends SlackCaptureKind>(client:PoolClient,identity:Identity,kind:K,runId:string):Promise<{value:SlackCheckpoints[K];revision:string}|null>{
  runIdSchema.parse(runId);
   if(!await check(client,identity))return null;
   const args=[...parameters(identity),kind,runId],{rows}=await client.query<CheckpointRow>('SELECT metadata,revision::text FROM opencrawl_slack_runs WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4 AND run_id=$5',args);
   if(!rows[0])return null;
   const items=(await client.query<Item>('SELECT item_kind kind,item_key key,ordinal,value FROM opencrawl_slack_run_items WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4 AND run_id=$5 ORDER BY ordinal,item_key',args)).rows;
   const value=joinCheckpoint(kind,rows[0].metadata,items) as SlackCheckpoints[K];
   if(value.scope!==identity.scope||value.runId!==runId)throw scopeError();
   return {value,revision:rows[0].revision};
 }
 async function saveCheckpoint<K extends SlackCaptureKind>(identity:Identity,kind:K,runId:string,input:SlackCheckpoints[K],revision:string|null){
  const value=validateCheckpoint(kind,input);if(value.scope!==identity.scope||value.runId!==runId)throw scopeError();
  if(revision!==null&&!/^[1-9][0-9]*$/.test(revision))throw conflict();
  return database.transaction(client=>saveCheckpointIn(client,identity,kind,runId,value,revision));
 }
 async function saveCheckpointIn<K extends SlackCaptureKind>(client:PoolClient,identity:Identity,kind:K,runId:string,input:SlackCheckpoints[K],revision:string|null){
  const value=validateCheckpoint(kind,input);if(value.scope!==identity.scope||value.runId!==runId)throw scopeError();
  if(revision!==null&&!/^[1-9][0-9]*$/.test(revision))throw conflict();
  const {metadata,items}=splitCheckpoint(value),args=[...parameters(identity),kind,runId];
   await lock(client,identity);
   const result=revision===null
    ?await client.query<{revision:string}>('INSERT INTO opencrawl_slack_runs(namespace,raw_prefix,scope_hash,kind,run_id,metadata) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING RETURNING revision::text',[...args,JSON.stringify(metadata)])
    :await client.query<{revision:string}>('UPDATE opencrawl_slack_runs SET metadata=$6::jsonb,revision=revision+1 WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4 AND run_id=$5 AND revision=$7::bigint RETURNING revision::text',[...args,JSON.stringify(metadata),revision]);
   if(!result.rows[0])throw conflict();
   await client.query(`WITH input AS (SELECT * FROM jsonb_to_recordset($6::jsonb) AS x(kind text,key text,ordinal integer,value jsonb)),
    upserted AS (INSERT INTO opencrawl_slack_run_items(namespace,raw_prefix,scope_hash,kind,run_id,item_kind,item_key,ordinal,value)
     SELECT $1,$2,$3,$4,$5,x.kind,x.key,x.ordinal,x.value FROM input x
     ON CONFLICT(namespace,raw_prefix,scope_hash,kind,run_id,item_kind,item_key) DO UPDATE SET ordinal=excluded.ordinal,value=excluded.value
     WHERE opencrawl_slack_run_items.value IS DISTINCT FROM excluded.value OR opencrawl_slack_run_items.ordinal<>excluded.ordinal)
    DELETE FROM opencrawl_slack_run_items old WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND kind=$4 AND run_id=$5
     AND NOT EXISTS(SELECT 1 FROM input x WHERE x.kind=old.item_kind AND x.key=old.item_key)`,[...args,JSON.stringify(items)]);
   return result.rows[0].revision;
 }
 const methodSchema=z.string().regex(/^(conversations\.(list|history|replies|info)|files\.(list|info))$/);
 async function defer(identity:Identity,method:string,due:number){methodSchema.parse(method);integer.parse(due);return database.transaction(client=>deferIn(client,identity,method,due));}
 async function deferIn(client:PoolClient,identity:Identity,method:string,due:number){
  methodSchema.parse(method);integer.parse(due);await lock(client,identity);
  await client.query(`INSERT INTO opencrawl_slack_pacing(namespace,raw_prefix,scope_hash,method,next_due) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(namespace,raw_prefix,scope_hash,method) DO UPDATE SET next_due=greatest(opencrawl_slack_pacing.next_due,excluded.next_due)`,[...parameters(identity),method,due]);
 }
 async function exportLegacyIn(client:PoolClient,key:string,expectedScope?:string):Promise<SlackLegacyValue|null>{
  if(expectedScope!==undefined)hash.parse(expectedScope);
  const source=slackCaptureLegacyIdentity(key),{rows}=await client.query<{scope_hash:string}>('SELECT scope_hash FROM opencrawl_slack_scopes WHERE namespace=$1 AND raw_prefix=$2 AND ($3::text IS NULL OR scope_hash=$3) LIMIT 2',[database.namespace,source.prefix,expectedScope??null]);
  if(rows.length>1)throw new Error('Explicit Slack capture binding required for a shared source prefix');
  if(!rows[0])return null;const identity={prefix:source.prefix,scope:rows[0].scope_hash};
  if(source.catalog)return readCatalogIn(client,identity,source.kind as SlackCatalogKind);
  return (await readCheckpointIn(client,identity,source.kind,source.runId!))?.value??null;
 }
 async function readProjectedLegacyIn(client:PoolClient,key:string,scope:string):Promise<SlackLegacyValue|null>{
  const value=await exportLegacyIn(client,key,scope);return value===null?null:normalizeSlackCaptureProjection(key,value);
 }
 /** The caller owns the replay transaction and its checkpoint. No runtime
  * admission, pool query, nested transaction, or source I/O occurs here. */
 async function projectLegacyIn(client:PoolClient,key:string,input:SlackLegacyValue,binding:ConnectorBinding){
  const source=slackCaptureLegacyIdentity(key),identity=bindingIdentity(binding),value=normalizeSlackCaptureProjection(key,input);
  if(source.prefix!==identity.prefix||value.scope!==identity.scope)throw scopeError();
  await lock(client,identity);
  if(source.catalog){
   const kind=source.kind as SlackCatalogKind,next=value as FileCatalog|MessageCatalog,prior=await readCatalogIn(client,identity,kind);
   const retains=(before:string[],after:string[])=>{const retained=new Set(after);return before.every(entry=>retained.has(entry));};
   if(new Set(next.channels).size!==next.channels.length||prior&&!retains(prior.channels,next.channels))throw new Error('Online Slack catalog cannot erase revocation history');
   if(kind==='files-v1'){
    const files=(next as FileCatalog).files,old=(prior as FileCatalog|null)?.files??{};
    if(Object.values(files).some(channels=>new Set(channels).size!==channels.length)||Object.entries(old).some(([id,channels])=>!Object.hasOwn(files,id)||!retains(channels,files[id])))throw new Error('Online Slack catalog cannot erase revocation history');
   }
   await mergeCatalogIn(client,identity,kind,next);
  }else{
   const checkpoint=value as FileCheckpoint|MessageCheckpoint|ReferenceCheckpoint,prior=await readCheckpointIn(client,identity,source.kind,source.runId!);
   if(!prior||!isDeepStrictEqual(canonical(prior.value),canonical(checkpoint)))await saveCheckpointIn(client,identity,source.kind,source.runId!,checkpoint,prior?.revision??null);
   if(typeof checkpoint.nextDue==='number')for(const method of ['conversations.list','files.list','files.info'])await deferIn(client,identity,method,checkpoint.nextDue);
   else for(const [method,due] of Object.entries(checkpoint.nextDue))await deferIn(client,identity,method,due);
  }
  if(!isDeepStrictEqual(canonical(await readProjectedLegacyIn(client,key,identity.scope)),canonical(value)))throw new Error('Online Slack typed readback differs from source');
 }
 const api={
  async ready(){
   preparing??=(async()=>{await database.ready();await database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:slack-capture:schema',0))");
    const definitions=[
     {name:'scopes',columns:"scope_hash text NOT NULL CHECK(scope_hash ~ '^[a-f0-9]{64}$')",key:'namespace,raw_prefix,scope_hash'},
     {name:'catalogs',columns:"scope_hash text NOT NULL,kind text NOT NULL CHECK(kind IN ('files-v1','messages-v1'))",key:'namespace,raw_prefix,scope_hash,kind',parent:'scopes',foreign:'namespace,raw_prefix,scope_hash'},
     {name:'catalog_items',columns:"scope_hash text NOT NULL,kind text NOT NULL,item_kind text NOT NULL CHECK(item_kind IN ('channel','file','file-share')),item_key text NOT NULL,ordinal integer NOT NULL,value jsonb",key:'namespace,raw_prefix,scope_hash,kind,item_kind,item_key',parent:'catalogs',foreign:'namespace,raw_prefix,scope_hash,kind'},
     {name:'runs',columns:"scope_hash text NOT NULL,kind text NOT NULL CHECK(kind IN ('files-v1','messages-v1','message-references-v1')),run_id text NOT NULL,metadata jsonb NOT NULL CHECK(octet_length(metadata::text)<=65536),revision bigint NOT NULL DEFAULT 1",key:'namespace,raw_prefix,scope_hash,kind,run_id',parent:'scopes',foreign:'namespace,raw_prefix,scope_hash'},
     {name:'run_items',columns:"scope_hash text NOT NULL,kind text NOT NULL,run_id text NOT NULL,item_kind text NOT NULL CHECK(item_kind IN ('channels','threads','files','file-channel','file-comment','prior-channel','error')),item_key text NOT NULL,ordinal integer NOT NULL,value jsonb NOT NULL",key:'namespace,raw_prefix,scope_hash,kind,run_id,item_kind,item_key',parent:'runs',foreign:'namespace,raw_prefix,scope_hash,kind,run_id'},
     {name:'pacing',columns:'scope_hash text NOT NULL,method text NOT NULL,next_due bigint NOT NULL CHECK(next_due>=0)',key:'namespace,raw_prefix,scope_hash,method',parent:'scopes',foreign:'namespace,raw_prefix,scope_hash'},
    ];
    for(const table of definitions)await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_slack_${table.name}(namespace text NOT NULL,raw_prefix text NOT NULL,${table.columns},PRIMARY KEY(${table.key}))`);
    const {rows}=await client.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='opencrawl_slack_scopes'::regclass AND contype='p'");
    if(rows[0]?.definition==='PRIMARY KEY (namespace, raw_prefix)'){
     // Upgrade the earlier single-prefix schema in one transaction. Every child
     // obtains its original binding digest before keys change. An orphan blocks
     // the upgrade; no table or source row is discarded or recreated.
     for(const table of definitions.slice(1)){
      await client.query(`ALTER TABLE opencrawl_slack_${table.name} ADD COLUMN IF NOT EXISTS scope_hash text`);
      await client.query(`UPDATE opencrawl_slack_${table.name} child SET scope_hash=owner.scope_hash FROM opencrawl_slack_scopes owner WHERE child.namespace=owner.namespace AND child.raw_prefix=owner.raw_prefix AND child.scope_hash IS NULL`);
      await client.query(`ALTER TABLE opencrawl_slack_${table.name} ALTER COLUMN scope_hash SET NOT NULL`);
     }
     for(const table of definitions)await client.query(`ALTER TABLE opencrawl_slack_${table.name} DROP CONSTRAINT opencrawl_slack_${table.name}_pkey, ADD PRIMARY KEY(${table.key})`);
    }else if(rows[0]?.definition!=='PRIMARY KEY (namespace, raw_prefix, scope_hash)')throw new Error('Unsupported Slack capture scope schema');
    for(const table of definitions.slice(1)){
     const constraint='opencrawl_slack_'+table.name+'_binding_fk';
     const exists=await client.query('SELECT 1 FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2',['opencrawl_slack_'+table.name,constraint]);
     if(!exists.rowCount)await client.query(`ALTER TABLE opencrawl_slack_${table.name} ADD CONSTRAINT ${constraint} FOREIGN KEY(${table.foreign}) REFERENCES opencrawl_slack_${table.parent}(${table.foreign}) ON DELETE CASCADE`);
    }
   });})().catch(error=>{preparing=undefined;throw error;});await preparing;
  },
  readCatalog:<K extends SlackCatalogKind>(binding:ConnectorBinding,kind:K)=>readCatalog(bindingIdentity(binding),kind),
  mergeCatalog:<K extends SlackCatalogKind>(binding:ConnectorBinding,kind:K,value:SlackCatalogs[K])=>mergeCatalog(bindingIdentity(binding),kind,value),
  readCheckpoint:<K extends SlackCaptureKind>(binding:ConnectorBinding,kind:K,runId:string)=>readCheckpoint(bindingIdentity(binding),kind,runId),
  saveCheckpoint:<K extends SlackCaptureKind>(binding:ConnectorBinding,kind:K,runId:string,value:SlackCheckpoints[K],revision:string|null)=>saveCheckpoint(bindingIdentity(binding),kind,runId,value,revision),
  async reserve(binding:ConnectorBinding,method:string,now:number,interval:number){
   const identity=bindingIdentity(binding);methodSchema.parse(method);integer.parse(now);integer.positive().parse(interval);integer.parse(now+interval);
   return database.transaction(async client=>{await lock(client,identity);const {rows}=await client.query<{next_due:string}>('SELECT next_due::text FROM opencrawl_slack_pacing WHERE namespace=$1 AND raw_prefix=$2 AND scope_hash=$3 AND method=$4',[...parameters(identity),method]);
    const waitMs=Math.max(0,Number(rows[0]?.next_due||0)-now);if(waitMs)return {reserved:false,waitMs};
    await client.query('INSERT INTO opencrawl_slack_pacing(namespace,raw_prefix,scope_hash,method,next_due) VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,raw_prefix,scope_hash,method) DO UPDATE SET next_due=excluded.next_due',[...parameters(identity),method,now+interval]);return {reserved:true,waitMs:0};});
  },
  defer:(binding:ConnectorBinding,method:string,due:number)=>defer(bindingIdentity(binding),method,due),
  validateLegacy:validateSlackCaptureLegacy,
  exportLegacyIn,readProjectedLegacyIn,projectLegacyIn,
  async importLegacy(key:string,bytes:Uint8Array){
   const source=slackCaptureLegacyIdentity(key),value=api.validateLegacy(key,bytes),identity={prefix:source.prefix,scope:value.scope};
   const prior=await api.exportLegacy(key,value.scope);
   if(prior!==null&&!isDeepStrictEqual(canonical(prior),canonical(value)))throw new Error('Legacy Slack capture state differs from initialized PostgreSQL state');
   if(source.catalog){if(prior===null)await mergeCatalog(identity,source.kind as SlackCatalogKind,value as FileCatalog|MessageCatalog);}
   else{
    const checkpoint=value as FileCheckpoint|MessageCheckpoint|ReferenceCheckpoint;
    if(prior===null)await saveCheckpoint(identity,source.kind,source.runId!,checkpoint,null);
    if(typeof checkpoint.nextDue==='number')for(const method of ['conversations.list','files.list','files.info'])await defer(identity,method,checkpoint.nextDue);
    else for(const [method,due] of Object.entries(checkpoint.nextDue))await defer(identity,method,due);
   }
   if(!isDeepStrictEqual(canonical(await api.exportLegacy(key,value.scope)),canonical(value)))throw new Error('Slack capture import verification failed');
  },
  async exportLegacy(key:string,expectedScope?:string):Promise<unknown>{
   return database.transaction(async client=>{await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return exportLegacyIn(client,key,expectedScope);});
  },
 };
 return api;
}
