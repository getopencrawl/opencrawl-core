import {randomBytes,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import type {ApplicationDatabase} from './postgres.mjs';
import type {OnboardingKind,OnboardingReceipt} from '../onboarding-status.mjs';
import type {Principal} from '../sessions/types.mjs';
import {sessionScope} from '../sessions/event-identity.mjs';

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
export interface AccountState {
  credentials:{
    create(record:CaptureCredentialRecord):Promise<void>;
    authenticate(id:string):Promise<CaptureCredentialRecord|null>;
    revokeAll(principal:Principal):Promise<void>;
    revoke(principal:Principal,id:string):Promise<void>;
  };
  onboarding:{read(ownerScope:string,kind:OnboardingKind):Promise<OnboardingReceipt|null>;write(ownerScope:string,kind:OnboardingKind,value:OnboardingReceipt):Promise<void>};
  roles:{acquire(organizationId:string,actorId:string,userId:string,role:'admin'|'member'|'remove'):Promise<{release():Promise<void>}>};
}

/** Small independent account records. Credential issuance and revocation serialize
 * on the owner, so a concurrent issue cannot escape a revocation accidentally. */
export function createAccountState(database:ApplicationDatabase):AccountState&{
  ready():Promise<void>;
  exportCredential(id:string):Promise<CaptureCredentialRecord|null>;
  exportGeneration(ownerScope:string):Promise<{generation:string}|null>;
  exportRole(organizationId:string):Promise<RoleWriteRecord|null>;
  importCredential(value:unknown):Promise<CaptureCredentialRecord>;
  importGeneration(ownerScope:string,value:unknown):Promise<{generation:string}>;
  importReceipt(ownerScope:string,kind:OnboardingKind,value:unknown):Promise<OnboardingReceipt>;
  importRole(organizationId:string,value:unknown):Promise<RoleWriteRecord>;
}{
  const ns=database.namespace;
  let prepared:Promise<void>|undefined;
  const lock=async(client:Parameters<Parameters<ApplicationDatabase['transaction']>[0]>[0],owner:string)=>{
    scope.parse(owner);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ns,'credential-owner',owner])]);
  };
  async function readCredential(id:string){hash.parse(id);const {rows}=await database.pool.query('SELECT record FROM opencrawl_capture_credentials WHERE namespace=$1 AND credential_id=$2',[ns,id]);return rows[0]?captureCredentialSchema.parse(rows[0].record):null;}
  const onboarding:AccountState['onboarding']={
    async read(owner,kind){scope.parse(owner);receiptKind.parse(kind);const {rows}=await database.pool.query('SELECT receipt FROM opencrawl_onboarding_receipts WHERE namespace=$1 AND owner_scope=$2 AND kind=$3',[ns,owner,kind]);return rows[0]?receiptSchema.parse(rows[0].receipt):null;},
    async write(owner,kind,value){scope.parse(owner);receiptKind.parse(kind);receiptSchema.parse(value);await database.pool.query(`INSERT INTO opencrawl_onboarding_receipts(namespace,owner_scope,kind,receipt) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(namespace,owner_scope,kind) DO UPDATE SET receipt=EXCLUDED.receipt`,[ns,owner,kind,JSON.stringify(value)]);},
  };
  return {
    exportCredential:readCredential,
    async exportGeneration(owner){scope.parse(owner);const {rows}=await database.pool.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND owner_scope=$2',[ns,owner]);return rows[0]?{generation:hash.parse(rows[0].generation)}:null;},
    async exportRole(organizationId){org.parse(organizationId);const {rows}=await database.pool.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2',[ns,organizationId]);return rows[0]?roleSchema.parse(rows[0].record):null;},
    async ready(){prepared??=(async()=>{await database.ready();await database.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:account-state:schema',0))");
      await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_capture_credentials(namespace text NOT NULL,credential_id text NOT NULL,owner_scope text NOT NULL,record jsonb NOT NULL,
        PRIMARY KEY(namespace,credential_id),CHECK(record->>'id'=credential_id));
        CREATE INDEX IF NOT EXISTS opencrawl_capture_credentials_owner ON opencrawl_capture_credentials(namespace,owner_scope);
        CREATE TABLE IF NOT EXISTS opencrawl_capture_generations(namespace text NOT NULL,owner_scope text NOT NULL,generation text NOT NULL,PRIMARY KEY(namespace,owner_scope));
        CREATE TABLE IF NOT EXISTS opencrawl_onboarding_receipts(namespace text NOT NULL,owner_scope text NOT NULL,kind text NOT NULL CHECK(kind IN ('cli','mcp','mcpTest','session','history','completed')),receipt jsonb NOT NULL,PRIMARY KEY(namespace,owner_scope,kind));
        CREATE TABLE IF NOT EXISTS opencrawl_role_writes(namespace text NOT NULL,organization_id text NOT NULL,record jsonb NOT NULL,PRIMARY KEY(namespace,organization_id))`);
    });})().catch(error=>{prepared=undefined;throw error;});await prepared;},
    credentials:{
      async create(input){const value=captureCredentialSchema.parse(input),owner=sessionScope(value.principal);await database.transaction(async client=>{
        await lock(client,owner);const {rows}=await client.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND owner_scope=$2',[ns,owner]);
        const record={...value,generation:rows[0]?.generation??''};await client.query('INSERT INTO opencrawl_capture_credentials(namespace,credential_id,owner_scope,record) VALUES($1,$2,$3,$4::jsonb)',[ns,value.id,owner,JSON.stringify(record)]);
      });},
      async authenticate(id){hash.parse(id);const {rows}=await database.pool.query(`SELECT c.record,g.generation FROM opencrawl_capture_credentials c LEFT JOIN opencrawl_capture_generations g USING(namespace,owner_scope) WHERE c.namespace=$1 AND c.credential_id=$2`,[ns,id]);
        if(!rows[0])return null;const record=captureCredentialSchema.parse(rows[0].record);return (record.generation??'')===(rows[0].generation??'')?record:null;},
      async revokeAll(principal){const owner=sessionScope(principal);await database.transaction(async client=>{await lock(client,owner);await client.query(`INSERT INTO opencrawl_capture_generations(namespace,owner_scope,generation) VALUES($1,$2,$3) ON CONFLICT(namespace,owner_scope) DO UPDATE SET generation=EXCLUDED.generation`,[ns,owner,randomBytes(32).toString('hex')]);});},
      async revoke(principal,id){hash.parse(id);const owner=sessionScope(principal);await database.transaction(async client=>{await lock(client,owner);const {rows}=await client.query('SELECT owner_scope FROM opencrawl_capture_credentials WHERE namespace=$1 AND credential_id=$2 FOR UPDATE',[ns,id]);
        if(!rows[0])return;if(rows[0].owner_scope!==owner)throw Object.assign(new Error('Credential owner mismatch'),{status:403});await client.query(`UPDATE opencrawl_capture_credentials SET record=record||'{"revoked":true}'::jsonb WHERE namespace=$1 AND credential_id=$2`,[ns,id]);});},
    },onboarding,
    roles:{async acquire(organizationId,actorId,userId,role){org.parse(organizationId);const operationId=randomUUID();const record=roleSchema.parse({schemaVersion:1,state:'held',operationId,organizationId,actorId,userId,role,startedAt:new Date().toISOString()});
      await database.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ns,'role-write',organizationId])]);
        const {rows}=await client.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2 FOR UPDATE',[ns,organizationId]);
        if(rows[0]&&roleSchema.parse(rows[0].record).state!=='idle')throw Object.assign(new Error('Another team change is in progress or awaiting verification. Contact your workspace operator if this continues.'),{status:409,expose:true});
        await client.query(`INSERT INTO opencrawl_role_writes(namespace,organization_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,organization_id) DO UPDATE SET record=EXCLUDED.record`,[ns,organizationId,JSON.stringify(record)]);
      });
      return {async release(){const next={schemaVersion:1,state:'idle',operationId,completedAt:new Date().toISOString()};const {rowCount}=await database.pool.query(`UPDATE opencrawl_role_writes SET record=$4::jsonb WHERE namespace=$1 AND organization_id=$2 AND record->>'state'='held' AND record->>'operationId'=$3`,[ns,organizationId,operationId,JSON.stringify(next)]);if(rowCount!==1)throw unavailable();}};
    }},
    async importCredential(input){const value=captureCredentialSchema.parse(input),owner=sessionScope(value.principal);await database.pool.query('INSERT INTO opencrawl_capture_credentials(namespace,credential_id,owner_scope,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[ns,value.id,owner,JSON.stringify(value)]);const actual=await readCredential(value.id);if(!isDeepStrictEqual(actual,value))throw conflict();return actual!;},
    async importGeneration(owner,input){scope.parse(owner);const value=z.object({generation:hash}).strict().parse(input);await database.pool.query('INSERT INTO opencrawl_capture_generations(namespace,owner_scope,generation) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[ns,owner,value.generation]);const {rows}=await database.pool.query('SELECT generation FROM opencrawl_capture_generations WHERE namespace=$1 AND owner_scope=$2',[ns,owner]);if(!isDeepStrictEqual(rows[0],value))throw conflict();return value;},
    async importReceipt(owner,kind,input){scope.parse(owner);receiptKind.parse(kind);const value=receiptSchema.parse(input);await database.pool.query('INSERT INTO opencrawl_onboarding_receipts(namespace,owner_scope,kind,receipt) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[ns,owner,kind,JSON.stringify(value)]);const actual=await onboarding.read(owner,kind);if(!isDeepStrictEqual(value,actual))throw conflict();return actual!;},
    async importRole(organizationId,input){org.parse(organizationId);const value=roleSchema.parse(input);if(value.state==='held'&&value.organizationId!==organizationId)throw conflict();await database.pool.query('INSERT INTO opencrawl_role_writes(namespace,organization_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[ns,organizationId,JSON.stringify(value)]);const {rows}=await database.pool.query('SELECT record FROM opencrawl_role_writes WHERE namespace=$1 AND organization_id=$2',[ns,organizationId]);if(!isDeepStrictEqual(rows[0].record,value))throw conflict();return value;},
  };
}
