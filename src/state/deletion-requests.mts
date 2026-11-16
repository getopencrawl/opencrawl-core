import type {Principal} from '../sessions/types.mjs';
import {isSessionHarness} from '../sessions/types.mjs';
import {digest,sessionScope} from '../sessions/event-identity.mjs';
import type {SessionDeletionRequest} from '../sessions/deletion-requests.mjs';
import type {ApplicationDatabase} from './postgres.mjs';
export interface SessionDeletionRequests {
  read(key:string):Promise<SessionDeletionRequest|null>;
  readFor(owner:Pick<Principal,'tenantId'|'userId'>,session:{harness:string;sessionId:string}):Promise<SessionDeletionRequest|null>;
  put(owner:Principal,session:{harness:string;sessionId:string}):Promise<string>;
  list(cursor?:string|null):Promise<{keys:string[];cursor:string|null}>;
  remove(key:string):Promise<void>;
}
export async function ensureDeletionRequestSchema(database:ApplicationDatabase){
  await database.ready();await database.transaction(async client=>{await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:deletion-requests:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_session_deletions(namespace text NOT NULL,request_key text NOT NULL,source_prefix text NOT NULL,
      tenant_id text NOT NULL,owner_id text NOT NULL,harness text NOT NULL,session_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(namespace,request_key),UNIQUE(namespace,source_prefix,tenant_id,owner_id,harness,session_id))`);
  });
}
export function createPostgresDeletionRequests(database:ApplicationDatabase,prefix:string):SessionDeletionRequests&{importRequest(key:string,request:SessionDeletionRequest):Promise<void>}{
  if(!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid deletion source prefix');
  const root=prefix+'/_deletions/v1/';
  const checkKey=(key:string)=>{if(typeof key!=='string'||!key.startsWith(root)||!/^[a-f0-9]{64}\.json$/.test(key.slice(root.length)))throw Object.assign(new Error('Session deletion scope denied'),{permanent:true});};
  function identity(request:SessionDeletionRequest){
    if(request?.schemaVersion!==1||!request.owner||Object.keys(request.owner).some(k=>!['tenantId','userId'].includes(k))||!isSessionHarness(request.harness)||!/^[A-Za-z0-9_.:-]{1,200}$/.test(request.sessionId||''))throw new Error('Invalid session deletion request');
    sessionScope(request.owner);return root+digest(JSON.stringify([prefix,request.owner.tenantId,request.owner.userId,request.harness,request.sessionId]))+'.json';
  }
  const request=(owner:Pick<Principal,'tenantId'|'userId'>,session:{harness:string;sessionId:string}):SessionDeletionRequest=>({schemaVersion:1,owner:{tenantId:owner.tenantId,userId:owner.userId},harness:session.harness,sessionId:session.sessionId});
  async function read(key:string){checkKey(key);const {rows}=await database.pool.query('SELECT tenant_id,owner_id,harness,session_id FROM opencrawl_session_deletions WHERE namespace=$1 AND source_prefix=$2 AND request_key=$3',[database.namespace,prefix,key]);
    if(!rows[0])return null;const value=request({tenantId:rows[0].tenant_id,userId:rows[0].owner_id},{harness:rows[0].harness,sessionId:rows[0].session_id});if(identity(value)!==key)throw new Error('Session deletion identity mismatch');return value;}
  async function insert(key:string,value:SessionDeletionRequest){
    checkKey(key);if(identity(value)!==key)throw new Error('Session deletion migration identity mismatch');
    await database.pool.query('INSERT INTO opencrawl_session_deletions(namespace,request_key,source_prefix,tenant_id,owner_id,harness,session_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[database.namespace,key,prefix,value.owner.tenantId,value.owner.userId,value.harness,value.sessionId]);
    if(!await read(key))throw new Error('Session deletion intent did not persist');
  }
  return {read,readFor:(owner,session)=>read(identity(request(owner,session))),
    async put(owner,session){if(owner.captureAccess!==undefined)throw Object.assign(new Error('Deletion requires owner access'),{status:403});const value=request(owner,session),key=identity(value);await insert(key,value);return key;},
    async list(cursor){if(cursor)checkKey(cursor);const {rows}=await database.pool.query('SELECT request_key FROM opencrawl_session_deletions WHERE namespace=$1 AND source_prefix=$2 AND request_key COLLATE "C">$3 ORDER BY request_key COLLATE "C" LIMIT 51',[database.namespace,prefix,cursor??'']);const keys=rows.slice(0,50).map(row=>String(row.request_key));for(const key of keys)checkKey(key);return {keys,cursor:rows.length>50?keys.at(-1)!:null};},
    async remove(key){checkKey(key);await database.pool.query('DELETE FROM opencrawl_session_deletions WHERE namespace=$1 AND source_prefix=$2 AND request_key=$3',[database.namespace,prefix,key]);},
    importRequest:insert,
  };
}
