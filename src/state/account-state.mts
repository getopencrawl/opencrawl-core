import {scanTargetInventoryIn,assertTargetInventoryBoundIn,targetInventoryFailure,targetInventoryValueBytes,type OnlineOwnedInventoryItem} from './online-target-inventory-support.mjs';
import {randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {ensureSchemaIndex,type ApplicationDatabase} from './postgres.mjs';
import type {PoolClient} from 'pg';
import type {OnboardingKind,OnboardingReceipt} from '../onboarding-status.mjs';
import type {Principal} from '../sessions/types.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';

const purposeSchema=z.enum(['capture','agent']);
export type CredentialPurpose=z.infer<typeof purposeSchema>;
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const scope=z.string().regex(/^tenants\/[a-f0-9]{64}\/users\/[a-f0-9]{64}$/);
const date=z.string().refine(value=>Number.isFinite(Date.parse(value)));
export const captureCredentialSchema=z.object({schemaVersion:z.literal(1),id:hash,
  principal:z.object({tenantId:z.string().min(1).max(200),userId:z.string().min(1).max(200),name:z.string().nullable().optional(),email:z.string().nullable().optional()}).strict(),
  expiresAt:date,revoked:z.boolean(),revokedAt:date.optional(),generation:z.union([z.literal(''),hash]).optional()}).strict();
export type CaptureCredentialRecord=z.infer<typeof captureCredentialSchema>;
export const onboardingReceiptSchema=z.object({observedAt:date,client:z.string().max(200).nullable().optional(),harness:z.string().max(100).optional(),state:z.string().max(100).optional()}).strict();
const receiptSchema=onboardingReceiptSchema;
const receiptKind=z.enum(['cli','mcp','mcpTest','session','history','completed']);
const org=z.string().regex(/^org_[A-Za-z0-9]+$/);
export const roleWriteSchema=z.discriminatedUnion('state',[
  z.object({schemaVersion:z.literal(1),state:z.literal('idle'),operationId:z.string().uuid(),completedAt:date}).strict(),
  z.object({schemaVersion:z.literal(1),state:z.literal('held'),operationId:z.string().uuid(),organizationId:org,
    actorId:z.string().min(1).max(200),userId:z.string().min(1).max(200),role:z.enum(['admin','member','remove']),startedAt:date}).strict(),
]);
const roleSchema=roleWriteSchema;
export type RoleWriteRecord=z.infer<typeof roleSchema>;
const conflict=()=>Object.assign(new Error('Application-state import conflicts with existing data'),{status:409});
const unavailable=()=>Object.assign(new Error('Team changes need a workspace operator check before continuing.'),{status:503,expose:true});
export type OnlineAccountProjection=
 |{kind:'credential';id:string;purpose:CredentialPurpose;value:CaptureCredentialRecord|null}
 |{kind:'generation';owner:string;purpose:CredentialPurpose;value:{generation:string}|null}
 |{kind:'onboarding';owner:string;receiptKind:OnboardingKind;value:OnboardingReceipt|null}
 |{kind:'role';organizationId:string;value:RoleWriteRecord|null};
export interface AccountState {
  credentials:{
    create(record:CaptureCredentialRecord,purpose?:CredentialPurpose):Promise<void>;
    authenticate(id:string,purpose?:CredentialPurpose):Promise<CaptureCredentialRecord|null>;
    revokeAll(principal:Principal,purpose?:CredentialPurpose):Promise<void>;
    revoke(principal:Principal,id:string,purpose?:CredentialPurpose):Promise<void>;
  };
  onboarding:{read(ownerScope:string,kind:OnboardingKind):Promise<OnboardingReceipt|null>;write(ownerScope:string,kind:OnboardingKind,value:OnboardingReceipt):Promise<void>};
  roles:{acquire(organizationId:string,actorId:string,userId:string,role:'admin'|'member'|'remove'):Promise<{release():Promise<void>}>};
}

// Inspect first: even ADD COLUMN IF NOT EXISTS takes ACCESS EXCLUSIVE on
// current tables and can invert a credential writer's generation -> record locks.
async function credentialUpgrade(client:PoolClient,table:string,key:string){
  const primary=await client.query<{name:string;definition:string;validated:boolean;deferrable:boolean;deferred:boolean}>(`SELECT conname AS name,pg_get_constraintdef(oid) AS definition,convalidated AS validated,condeferrable AS deferrable,condeferred AS deferred FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='p'`,[table]);
  const pk=primary.rows[0],compact=(value:string)=>value.replace(/\s+/g,'');
  if(primary.rows.length!==1||!pk||pk.name!==table+'_pkey'||!pk.validated||pk.deferrable||pk.deferred)throw new Error('Incompatible credential primary key');
  const legacy=compact(pk.definition)===`PRIMARYKEY(namespace,${key})`;
  if(!legacy&&compact(pk.definition)!==`PRIMARYKEY(namespace,purpose,${key})`)throw new Error('Incompatible credential primary key');
  const columns=await client.query<{text_type:boolean;not_null:boolean;generated:string;identity:string;default_value:string|null;default_collation:boolean;number:number}>(`SELECT a.atttypid='pg_catalog.text'::regtype AS text_type,a.attnotnull AS not_null,a.attgenerated AS generated,a.attidentity AS identity,pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attcollation='pg_catalog."default"'::regcollation AS default_collation,a.attnum AS number FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass($1) AND a.attname='purpose' AND NOT a.attisdropped`,[table]);
  const column=columns.rows[0];
  if(!column){if(!legacy)throw new Error('Credential purpose column missing from current schema');return {table,key,addPurpose:true,legacy};}
  const checks=await client.query<{definition:string;validated:boolean;no_inherit:boolean}>(`SELECT pg_get_constraintdef(oid) AS definition,convalidated AS validated,connoinherit AS no_inherit FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='c' AND conkey=ARRAY[$2]::smallint[]`,[table,column.number]);
  const check=checks.rows[0];
  if(columns.rows.length!==1||!column.text_type||!column.not_null||column.generated!==''||column.identity!==''||column.default_value!=="'capture'::text"||!column.default_collation||checks.rows.length!==1||!check?.validated||check.no_inherit||compact(check.definition)!=="CHECK((purpose=ANY(ARRAY['capture'::text,'agent'::text])))")throw new Error('Incompatible credential purpose column');
  return {table,key,addPurpose:false,legacy};
}

/** Small independent account records. Credential issuance and revocation serialize
 * on the owner, so a concurrent issue cannot escape a revocation accidentally. */
export function createAccountState(database:ApplicationDatabase):AccountState&{
  ready():Promise<void>;
  readIn(client:PoolClient,record:OnlineAccountProjection):Promise<unknown>;
  projectIn(client:PoolClient,record:OnlineAccountProjection):Promise<void>;
  exportCredential(id:string,purpose?:CredentialPurpose):Promise<CaptureCredentialRecord|null>;
  exportGeneration(ownerScope:string,purpose?:CredentialPurpose):Promise<{generation:string}|null>;
  exportRole(organizationId:string):Promise<RoleWriteRecord|null>;
  importCredential(value:unknown,purpose?:CredentialPurpose):Promise<CaptureCredentialRecord>;
  importGeneration(ownerScope:string,value:unknown,purpose?:CredentialPurpose):Promise<{generation:string}>;
  importReceipt(ownerScope:string,kind:OnboardingKind,value:unknown):Promise<OnboardingReceipt>;
  importRole(organizationId:string,value:unknown):Promise<RoleWriteRecord>;
}{
  const ns=database.namespace;
  let prepared:Promise<void>|undefined;
  const lock=async(client:Parameters<Parameters<ApplicationDatabase['transaction']>[0]>[0],owner:string,purpose:CredentialPurpose)=>{
    scope.parse(owner);purposeSchema.parse(purpose);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ns,'credential-owner',purpose,owner])]);
  };
  async function readCredential(id:string,purpose:CredentialPurpose='capture'){hash.parse(id);purposeSchema.parse(purpose);const {rows}=await database.pool.query('SELECT record FROM opencrawl_capture_credentials WHERE namespace=$1 AND credential_id=$2 AND purpose=$3',[ns,id,purpose]);return rows[0]?captureCredentialSchema.parse(rows[0].record):null;}
  const onboarding:AccountState['onboarding']={
    async read(owner,kind){scope.parse(owner);receiptKind.parse(kind);const {rows}=await database.pool.query('SELECT receipt FROM opencrawl_onboarding_receipts WHERE namespace=$1 AND owner_scope=$2 AND kind=$3',[ns,owner,kind]);return rows[0]?receiptSchema.parse(rows[0].receipt):null;},
    async write(owner,kind,value){scope.parse(owner);receiptKind.parse(kind);receiptSchema.parse(value);await database.pool.query(`INSERT INTO opencrawl_onboarding_receipts(namespace,owner_scope,kind,receipt) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(namespace,owner_scope,kind) DO UPDATE SET receipt=EXCLUDED.receipt`,[ns,owner,kind,JSON.stringify(value)]);},
  };
  async function readIn(client:PoolClient,input:OnlineAccountProjection):Promise<unknown>{
    if(input.kind==='credential'){hash.parse(input.id);purposeSchema.parse(input.purpose);const row=(await client.query('SELECT record FROM opencrawl_capture_credentials WHERE namespace=$1 AND purpose=$2 AND credential_id=$3',[ns,input.purpose,input.id])).rows[0];return row?captureCredentialSchema.parse(row.record):null;}
    if(input.kind==='generation'){scope.parse(input.owner);purposeSchema.parse(input.purpose);const row=(await client.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND purpose=$2 AND owner_scope=$3',[ns,input.purpose,input.owner])).rows[0];return row?{generation:hash.parse(row.generation)}:null;}
    if(input.kind==='onboarding'){scope.parse(input.owner);receiptKind.parse(input.receiptKind);const row=(await client.query('SELECT receipt FROM opencrawl_onboarding_receipts WHERE namespace=$1 AND owner_scope=$2 AND kind=$3',[ns,input.owner,input.receiptKind])).rows[0];return row?receiptSchema.parse(row.receipt):null;}
    org.parse(input.organizationId);const row=(await client.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2',[ns,input.organizationId])).rows[0];return row?roleSchema.parse(row.record):null;
  }
  async function projectIn(client:PoolClient,input:OnlineAccountProjection){
    if(input.kind==='credential'){
      hash.parse(input.id);purposeSchema.parse(input.purpose);const value=input.value===null?null:captureCredentialSchema.parse(input.value);
      if(value&&value.id!==input.id)throw conflict();
      const prior=await readIn(client,input) as CaptureCredentialRecord|null,owner=value?sessionScope(value.principal):prior?sessionScope(prior.principal):null;
      if(owner)await lock(client,owner,input.purpose);
      const current=await readIn(client,input) as CaptureCredentialRecord|null;
      if(current&&value&&(sessionScope(current.principal)!==owner||current.revoked&&!value.revoked))throw conflict();
      if(value===null)await client.query('DELETE FROM opencrawl_capture_credentials WHERE namespace=$1 AND purpose=$2 AND credential_id=$3',[ns,input.purpose,input.id]);
      else await client.query('INSERT INTO opencrawl_capture_credentials(namespace,purpose,credential_id,owner_scope,record) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(namespace,purpose,credential_id) DO UPDATE SET record=EXCLUDED.record',[ns,input.purpose,input.id,owner,JSON.stringify(value)]);
      return;
    }
    if(input.kind==='generation'){
      scope.parse(input.owner);purposeSchema.parse(input.purpose);if(input.value===null)throw new Error('Online projection cannot erase a credential revocation generation');
      const value=z.object({generation:hash}).strict().parse(input.value);await lock(client,input.owner,input.purpose);
      await client.query('INSERT INTO opencrawl_capture_generations(namespace,purpose,owner_scope,generation) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,purpose,owner_scope) DO UPDATE SET generation=EXCLUDED.generation',[ns,input.purpose,input.owner,value.generation]);return;
    }
    if(input.kind==='onboarding'){
      scope.parse(input.owner);receiptKind.parse(input.receiptKind);
      if(input.value===null)await client.query('DELETE FROM opencrawl_onboarding_receipts WHERE namespace=$1 AND owner_scope=$2 AND kind=$3',[ns,input.owner,input.receiptKind]);
      else{const value=receiptSchema.parse(input.value);await client.query('INSERT INTO opencrawl_onboarding_receipts(namespace,owner_scope,kind,receipt) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(namespace,owner_scope,kind) DO UPDATE SET receipt=EXCLUDED.receipt',[ns,input.owner,input.receiptKind,JSON.stringify(value)]);}return;
    }
    org.parse(input.organizationId);const value=input.value===null?null:roleSchema.parse(input.value);if(value?.state==='held'&&value.organizationId!==input.organizationId)throw conflict();
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ns,'role-write',input.organizationId])]);
    const prior=await readIn(client,input) as RoleWriteRecord|null;
    if(prior?.state==='held'&&(!value||value.operationId!==prior.operationId||value.state==='held'&&!isDeepStrictEqual(prior,value)))throw unavailable();
    if(value===null)await client.query('DELETE FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2',[ns,input.organizationId]);
    else await client.query('INSERT INTO opencrawl_role_writes(namespace,organization_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,organization_id) DO UPDATE SET record=EXCLUDED.record',[ns,input.organizationId,JSON.stringify(value)]);
  }
  return {
    readIn,projectIn,
    exportCredential:readCredential,
    async exportGeneration(owner,purpose='capture'){scope.parse(owner);purposeSchema.parse(purpose);const {rows}=await database.pool.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND owner_scope=$2 AND purpose=$3',[ns,owner,purpose]);return rows[0]?{generation:hash.parse(rows[0].generation)}:null;},
    async exportRole(organizationId){org.parse(organizationId);const {rows}=await database.pool.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2',[ns,organizationId]);return rows[0]?roleSchema.parse(rows[0].record):null;},
    async ready(){prepared??=(async()=>{await database.ready();await database.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:account-state:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_capture_credentials(namespace text NOT NULL,purpose text NOT NULL DEFAULT 'capture' CHECK(purpose IN ('capture','agent')),credential_id text NOT NULL,owner_scope text NOT NULL,record jsonb NOT NULL,
        PRIMARY KEY(namespace,purpose,credential_id),CHECK(record->>'id'=credential_id));
        CREATE TABLE IF NOT EXISTS opencrawl_capture_generations(namespace text NOT NULL,purpose text NOT NULL DEFAULT 'capture' CHECK(purpose IN ('capture','agent')),owner_scope text NOT NULL,generation text NOT NULL,PRIMARY KEY(namespace,purpose,owner_scope));
        CREATE TABLE IF NOT EXISTS opencrawl_onboarding_receipts(namespace text NOT NULL,owner_scope text NOT NULL,kind text NOT NULL CHECK(kind IN ('cli','mcp','mcpTest','session','history','completed')),receipt jsonb NOT NULL,PRIMARY KEY(namespace,owner_scope,kind));
        CREATE TABLE IF NOT EXISTS opencrawl_role_writes(namespace text NOT NULL,organization_id text NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,organization_id))`);
      const upgrades=await Promise.all([
        credentialUpgrade(client,'opencrawl_capture_credentials','credential_id'),
        credentialUpgrade(client,'opencrawl_capture_generations','owner_scope'),
      ]);
      for(const upgrade of upgrades){
        if(upgrade.addPurpose)await client.query(`ALTER TABLE ${upgrade.table} ADD COLUMN purpose text NOT NULL DEFAULT 'capture' CHECK(purpose IN ('capture','agent'))`);
        if(upgrade.legacy)await client.query(`ALTER TABLE ${upgrade.table} DROP CONSTRAINT ${upgrade.table}_pkey, ADD PRIMARY KEY(namespace,purpose,${upgrade.key})`);
      }
      const legacyIndex=await client.query<{qualified_name:string}>(`SELECT format('%I.%I',n.nspname,idx.relname) AS qualified_name FROM pg_class idx JOIN pg_namespace n ON n.oid=idx.relnamespace JOIN pg_class t ON t.relnamespace=idx.relnamespace WHERE t.oid=to_regclass('opencrawl_capture_credentials') AND idx.relname='opencrawl_capture_credentials_owner'`);
      if(legacyIndex.rowCount){
        await ensureSchemaIndex(client,{table:'opencrawl_capture_credentials',name:'opencrawl_capture_credentials_owner',keys:['namespace','owner_scope']});
        await client.query('DROP INDEX '+legacyIndex.rows[0]!.qualified_name);
      }
      await ensureSchemaIndex(client,{table:'opencrawl_capture_credentials',name:'opencrawl_credentials_purpose_owner',keys:['namespace','purpose','owner_scope']});
    });})().catch(error=>{prepared=undefined;throw error;});await prepared;},
    credentials:{
      async create(input,purpose='capture'){purposeSchema.parse(purpose);const value=captureCredentialSchema.parse(input),owner=sessionScope(value.principal);await database.transaction(async client=>{
        await lock(client,owner,purpose);const {rows}=await client.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND owner_scope=$2 AND purpose=$3',[ns,owner,purpose]);
        const record={...value,generation:rows[0]?.generation??''};await client.query('INSERT INTO opencrawl_capture_credentials(namespace,credential_id,owner_scope,record,purpose) VALUES($1,$2,$3,$4::jsonb,$5)',[ns,value.id,owner,JSON.stringify(record),purpose]);
      });},
      async authenticate(id,purpose='capture'){hash.parse(id);purposeSchema.parse(purpose);const {rows}=await database.pool.query(`SELECT c.record,g.generation FROM opencrawl_capture_credentials c LEFT JOIN opencrawl_capture_generations g USING(namespace,purpose,owner_scope) WHERE c.namespace=$1 AND c.credential_id=$2 AND c.purpose=$3`,[ns,id,purpose]);
        if(!rows[0])return null;const record=captureCredentialSchema.parse(rows[0].record);return (record.generation??'')===(rows[0].generation??'')?record:null;},
      async revokeAll(principal,purpose='capture'){const owner=sessionScope(principal);await database.transaction(async client=>{await lock(client,owner,purpose);await client.query(`INSERT INTO opencrawl_capture_generations(namespace,owner_scope,generation,purpose) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,purpose,owner_scope) DO UPDATE SET generation=EXCLUDED.generation`,[ns,owner,randomBytes(32).toString('hex'),purpose]);});},
      async revoke(principal,id,purpose='capture'){hash.parse(id);const owner=sessionScope(principal);await database.transaction(async client=>{await lock(client,owner,purpose);const {rows}=await client.query('SELECT owner_scope FROM opencrawl_capture_credentials WHERE namespace=$1 AND credential_id=$2 AND purpose=$3 FOR UPDATE',[ns,id,purpose]);
        if(!rows[0])return;if(rows[0].owner_scope!==owner)throw Object.assign(new Error('Credential owner mismatch'),{status:403});await client.query(`UPDATE opencrawl_capture_credentials SET record=record||'{"revoked":true}'::jsonb WHERE namespace=$1 AND credential_id=$2 AND purpose=$3`,[ns,id,purpose]);});},
    },onboarding,
    roles:{async acquire(organizationId,actorId,userId,role){org.parse(organizationId);const operationId=randomUUID();const record=roleSchema.parse({schemaVersion:1,state:'held',operationId,organizationId,actorId,userId,role,startedAt:new Date().toISOString()});
      await database.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ns,'role-write',organizationId])]);
        const {rows}=await client.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2 FOR UPDATE',[ns,organizationId]);
        if(rows[0]){const prior=roleSchema.safeParse(rows[0].record);if(!prior.success)throw unavailable();if(prior.data.state!=='idle')throw Object.assign(new Error('Another team change is in progress or awaiting verification. Contact your workspace operator if this continues.'),{status:409,expose:true});}
        await client.query(`INSERT INTO opencrawl_role_writes(namespace,organization_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,organization_id) DO UPDATE SET record=EXCLUDED.record`,[ns,organizationId,JSON.stringify(record)]);
      });
      return {async release(){const next={schemaVersion:1,state:'idle',operationId,completedAt:new Date().toISOString()};const {rowCount}=await database.pool.query(`UPDATE opencrawl_role_writes SET record=$4::jsonb WHERE namespace=$1 AND organization_id=$2 AND record->>'state'='held' AND record->>'operationId'=$3`,[ns,organizationId,operationId,JSON.stringify(next)]);if(rowCount!==1)throw unavailable();}};
    }},
    async importCredential(input,purpose='capture'){purposeSchema.parse(purpose);const value=captureCredentialSchema.parse(input),owner=sessionScope(value.principal);await database.pool.query('INSERT INTO opencrawl_capture_credentials(namespace,credential_id,owner_scope,record,purpose) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',[ns,value.id,owner,JSON.stringify(value),purpose]);const actual=await readCredential(value.id,purpose);if(!isDeepStrictEqual(actual,value))throw conflict();return actual!;},
    async importGeneration(owner,input,purpose='capture'){scope.parse(owner);purposeSchema.parse(purpose);const value=z.object({generation:hash}).strict().parse(input);await database.pool.query('INSERT INTO opencrawl_capture_generations(namespace,owner_scope,generation,purpose) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ns,owner,value.generation,purpose]);const {rows}=await database.pool.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND owner_scope=$2 AND purpose=$3',[ns,owner,purpose]);if(!isDeepStrictEqual(rows[0],value))throw conflict();return value;},
    async importReceipt(owner,kind,input){scope.parse(owner);receiptKind.parse(kind);const value=receiptSchema.parse(input);await database.pool.query('INSERT INTO opencrawl_onboarding_receipts(namespace,owner_scope,kind,receipt) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[ns,owner,kind,JSON.stringify(value)]);const actual=await onboarding.read(owner,kind);if(!isDeepStrictEqual(value,actual))throw conflict();return actual!;},
    async importRole(organizationId,input){org.parse(organizationId);const value=roleSchema.parse(input);if(value.state==='held'&&value.organizationId!==organizationId)throw conflict();await database.pool.query('INSERT INTO opencrawl_role_writes(namespace,organization_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[ns,organizationId,JSON.stringify(value)]);const {rows}=await database.pool.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2',[ns,organizationId]);if(!isDeepStrictEqual(rows[0].record,value))throw conflict();return value;},
  };
}

/** Read every actual account owner independently of migration heads. */
export async function* inventoryAccountTargetsIn(database:ApplicationDatabase,client:PoolClient):AsyncGenerator<OnlineOwnedInventoryItem>{
 const ns=database.namespace,repo=createAccountState(database);
 for(const table of ['credentials','generations','onboarding','roles'] as const){
  const query=table==='credentials'?"SELECT purpose,credential_id,owner_scope,octet_length(record::text) bytes FROM opencrawl_capture_credentials WHERE namespace=$1 ORDER BY purpose COLLATE \"C\",credential_id COLLATE \"C\"":table==='generations'?"SELECT purpose,owner_scope FROM opencrawl_capture_generations WHERE namespace=$1 ORDER BY purpose COLLATE \"C\",owner_scope COLLATE \"C\"":table==='onboarding'?"SELECT owner_scope,kind,octet_length(receipt::text) bytes FROM opencrawl_onboarding_receipts WHERE namespace=$1 ORDER BY owner_scope COLLATE \"C\",kind COLLATE \"C\"":"SELECT organization_id,octet_length(record::text) bytes FROM opencrawl_role_writes WHERE namespace=$1 ORDER BY organization_id COLLATE \"C\"";
  for await(const row of scanTargetInventoryIn(client,query,[ns])){
   if(row.bytes!==undefined&&(!Number.isSafeInteger(row.bytes)||Number(row.bytes)>131072))targetInventoryFailure('oversized account row');
   let record:OnlineAccountProjection,domain:string,identity:string[];
   if(table==='credentials'){const purpose=purposeSchema.parse(row.purpose),id=hash.parse(row.credential_id);record={kind:'credential',purpose,id,value:null};domain='capture-credentials';identity=[purpose,id];}
   else if(table==='generations'){const purpose=purposeSchema.parse(row.purpose),owner=scope.parse(row.owner_scope);record={kind:'generation',purpose,owner,value:null};domain='credential-generations';identity=[purpose,owner];}
   else if(table==='onboarding'){const owner=scope.parse(row.owner_scope),kind=receiptKind.parse(row.kind);record={kind:'onboarding',owner,receiptKind:kind,value:null};domain='onboarding';identity=[owner,kind];}
   else{const organizationId=org.parse(row.organization_id);record={kind:'role',organizationId,value:null};domain='role-writes';identity=[organizationId];}
   const value=await repo.readIn(client,record);if(value===null)targetInventoryFailure('account owner disappeared');
   if(record.kind==='credential'){const parsed=captureCredentialSchema.parse(value);if(parsed.id!==record.id||sessionScope(parsed.principal)!==row.owner_scope)targetInventoryFailure('credential normalized owner differs');}
   if(record.kind==='role'){const parsed=roleSchema.parse(value);if(parsed.state==='held'&&parsed.organizationId!==record.organizationId)targetInventoryFailure('role owner differs');}
   yield {kind:'target',domains:[domain],identity,value,maxBytes:65536};
  }
 }
}
