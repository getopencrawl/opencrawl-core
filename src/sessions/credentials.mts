import type {Principal} from './types.mjs';
import type {ApplicationState} from '../state/types.mjs';
import {randomBytes} from 'node:crypto';
import {digest,sessionScope} from './event-identity.mjs';
function deny(status:number,message:string):never{throw Object.assign(new Error(message),{status});}
export const isCaptureCredential=(token:unknown):token is string=>typeof token==='string'&&/^occ1_[a-f0-9]{64}$/.test(token);
/** Opaque upload-only delegation. Only hashes enter PostgreSQL. */
export function createCaptureCredentials({state,now=Date.now}:{state:ApplicationState;now?:()=>number}){
  const repository=state.accounts.credentials;
  return {
    async issue(principal:Principal){sessionScope(principal);if(principal.captureAccess!==undefined)deny(403,'Capture credentials cannot delegate access');
      const token='occ1_'+randomBytes(32).toString('hex'),id=digest(token),expiresAt=new Date(now()+365*86400000).toISOString();
      await repository.create({schemaVersion:1,id,principal:{tenantId:principal.tenantId,userId:principal.userId,name:principal.name??null,email:principal.email??null},expiresAt,revoked:false});
      return {id,token,expiresAt,access:'capture-write'};
    },
    async authenticate(token:string){if(!isCaptureCredential(token))return null;const record=await repository.authenticate(digest(token));
      if(!record||record.id!==digest(token)||record.revoked||Date.parse(record.expiresAt)<=now())return null;sessionScope(record.principal);return {...record.principal,captureAccess:'write'};
    },
    async revokeAll(principal:Principal){sessionScope(principal);if(principal.captureAccess!==undefined)deny(403,'Capture credentials cannot manage credentials');await repository.revokeAll(principal);},
    async revoke(principal:Principal,id:string){sessionScope(principal);if(principal.captureAccess!==undefined)deny(403,'Capture credentials cannot manage credentials');if(!/^[a-f0-9]{64}$/.test(id))deny(400,'Invalid credential ID');await repository.revoke(principal,id);return {revoked:true};},
  };
}
