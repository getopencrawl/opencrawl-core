import {randomBytes} from 'node:crypto';
import {digest,sessionScope} from './ingest.mjs';

const deny=(status,message)=>{throw Object.assign(new Error(message),{status});};
export const isCaptureCredential = token => typeof token==='string' && /^occ1_[a-f0-9]{64}$/.test(token);
/** Opaque, upload-only delegation. Only hashes are stored; every lookup checks expiry/revocation. */
export function createCaptureCredentials({store,prefix='capture-v1',now=Date.now}) {
  const key=id=>`${prefix}/_credentials/${id}.json`;
  return {
    async issue(principal) {
      sessionScope(principal);
      if(principal.captureAccess==='write')deny(403,'Capture credentials cannot delegate access');
      const token='occ1_'+randomBytes(32).toString('hex'),id=digest(token);
      const expiresAt=new Date(now()+365*86400000).toISOString();
      await store.put(key(id),Buffer.from(JSON.stringify({schemaVersion:1,id,principal:{tenantId:principal.tenantId,userId:principal.userId,name:principal.name??null,email:principal.email??null},expiresAt,revoked:false})),'application/json');
      return {id,token,expiresAt,access:'capture-write'};
    },
    async authenticate(token) {
      if(!isCaptureCredential(token))return null;
      const bytes=await store.get(key(digest(token)));if(!bytes)return null;
      const record=JSON.parse(bytes);
      if(record.schemaVersion!==1||record.id!==digest(token)||record.revoked||!Number.isFinite(Date.parse(record.expiresAt))||Date.parse(record.expiresAt)<=now())return null;
      sessionScope(record.principal);
      return {...record.principal,captureAccess:'write'};
    },
    async revoke(principal,id) {
      sessionScope(principal);
      if(principal.captureAccess==='write')deny(403,'Capture credentials cannot manage credentials');
      if(!/^[a-f0-9]{64}$/.test(id))deny(400,'Invalid credential ID');
      const bytes=await store.get(key(id));if(!bytes)return {revoked:true};
      const record=JSON.parse(bytes);
      if(sessionScope(record.principal)!==sessionScope(principal))deny(403,'Credential owner mismatch');
      await store.put(key(id),Buffer.from(JSON.stringify({...record,revoked:true})),'application/json');
      return {revoked:true};
    },
  };
}
