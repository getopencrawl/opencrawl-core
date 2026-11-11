import type {Principal, ObjectStore} from './types.mjs';
import {parseJson} from './types.mjs';
interface CredentialRecord {schemaVersion: number; id: string; principal: Principal; expiresAt: string; revoked: boolean; revokedAt?: string; generation?: string}
import {randomBytes} from 'node:crypto';
import {digest,sessionScope} from './ingest.mjs';

function deny(status: number,message: string): never {throw Object.assign(new Error(message),{status});}
export const isCaptureCredential = (token: unknown): token is string => typeof token==='string' && /^occ1_[a-f0-9]{64}$/.test(token);
/** Opaque, upload-only delegation. Only hashes are stored; every lookup checks expiry/revocation. */
export function createCaptureCredentials({store,prefix='capture-v1',now=Date.now}: {store: ObjectStore; prefix?: string; now?: () => number}) {
  const key=(id: string)=>`${prefix}/_credentials/${id}.json`;
  const generationKey=(principal:Principal)=>`${prefix}/_credential-generations/${sessionScope(principal)}.json`;
  const generation=async(principal:Principal)=>{
    const bytes=await store.get(generationKey(principal));if(!bytes)return '';
    const value=parseJson<{generation?:unknown}>(bytes).generation;
    if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))deny(503,'Credential revocation state unavailable');
    return value as string;
  };
  return {
    async issue(principal: Principal) {
      sessionScope(principal);
      if(principal.captureAccess==='write')deny(403,'Capture credentials cannot delegate access');
      const token='occ1_'+randomBytes(32).toString('hex'),id=digest(token);
      const expiresAt=new Date(now()+365*86400000).toISOString();
      await store.put(key(id),Buffer.from(JSON.stringify({schemaVersion:1,id,principal:{tenantId:principal.tenantId,userId:principal.userId,name:principal.name??null,email:principal.email??null},expiresAt,revoked:false,generation:await generation(principal)})),'application/json');
      return {id,token,expiresAt,access:'capture-write'};
    },
    async authenticate(token: string) {
      if(!isCaptureCredential(token))return null;
      const bytes=await store.get(key(digest(token)));if(!bytes)return null;
      const record=parseJson<CredentialRecord>(bytes);
      if(record.schemaVersion!==1||record.id!==digest(token)||record.revoked||!Number.isFinite(Date.parse(record.expiresAt))||Date.parse(record.expiresAt)<=now())return null;
      sessionScope(record.principal);
      if((record.generation??'')!==await generation(record.principal))return null;
      return {...record.principal,captureAccess:'write'};
    },
    /** Invalidates every existing delegation for one owner, including after reinvitation. */
    async revokeAll(principal:Principal){
      sessionScope(principal);
      if(principal.captureAccess==='write')deny(403,'Capture credentials cannot manage credentials');
      await store.put(generationKey(principal),Buffer.from(JSON.stringify({generation:randomBytes(32).toString('hex')})),'application/json');
    },
    async revoke(principal: Principal,id: string) {
      sessionScope(principal);
      if(principal.captureAccess==='write')deny(403,'Capture credentials cannot manage credentials');
      if(!/^[a-f0-9]{64}$/.test(id))deny(400,'Invalid credential ID');
      const bytes=await store.get(key(id));if(!bytes)return {revoked:true};
      const record=parseJson<CredentialRecord>(bytes);
      if(sessionScope(record.principal)!==sessionScope(principal))deny(403,'Credential owner mismatch');
      await store.put(key(id),Buffer.from(JSON.stringify({...record,revoked:true})),'application/json');
      return {revoked:true};
    },
  };
}
