import {randomBytes} from 'node:crypto';
import type {ObjectStore,Principal} from './types.mjs';
import {sessionScope} from './event-identity.mjs';
import {fail as deny} from '../errors.mjs';
import {credentialDigest,credentialService,type CredentialRepository,type CredentialRecord} from './credential-service.mjs';
export * from './credential-service.mjs';

function credentialJson<T>(bytes:Buffer):T{
  try{return JSON.parse(bytes.toString());}catch{throw Error('Invalid credential source document');}
}

export const credentialReadLimit=16*1024*1024;
/** Object transport messages can include a credential digest or an owner path. */
export async function credentialSource<T>(run:()=>Promise<T>):Promise<T>{
  try{return await run();}catch(caught){
    if((caught as {code?:unknown})?.code==='ObjectReadLimitExceeded')throw Error('Retained credential document exceeds its bounded read limit');
    const error=Object.assign(new Error('Credential source unavailable'),{status:503});
    if((caught as {writeOutcome?:unknown})?.writeOutcome==='not-applied')Object.assign(error,{writeOutcome:'not-applied'});
    throw error;
  }
}

export function objectCredentialRepository(store:ObjectStore,prefix:string):CredentialRepository {
  const key=(id:string)=>prefix+'/_credentials/'+id+'.json';
  const generationKey=(principal:Principal)=>prefix+'/_credential-generations/'+sessionScope(principal)+'.json';
  async function generation(principal:Principal){
    const bytes=await credentialSource(()=>store.get(generationKey(principal)));
    if(!bytes)return '';
    const value=credentialJson<{generation?:unknown}>(bytes).generation;
    if(!credentialDigest(value))deny(503,'Credential revocation state unavailable');
    return value;
  }
  return {
    async create(record){
      const bytes=Buffer.from(JSON.stringify({...record,generation:await generation(record.principal)}));
      await credentialSource(()=>store.put(key(record.id),bytes,'application/json'));
    },
    async lookup(id,clock){
      const bytes=await credentialSource(()=>store.get(key(id)));if(!bytes)return null;
      const record=credentialJson<CredentialRecord>(bytes);
      if(record.schemaVersion!==1 || record.id!==id || record.revoked || !(Date.parse(record.expiresAt)>clock()))return null;
      sessionScope(record.principal);
      return (record.generation??'')===await generation(record.principal) ? {principal:record.principal,expiresAt:record.expiresAt} : null;
    },
    async removalVersion(principal){
      return (await credentialSource(()=>store.readVersion(generationKey(principal),{maxBytes:1024}))).version;
    },
    async rotate(principal,version){
      const bytes=Buffer.from(JSON.stringify({generation:randomBytes(32).toString('hex')}));
      if(version===undefined)await credentialSource(()=>store.put(generationKey(principal),bytes,'application/json'));
      else await credentialSource(()=>store.compareAndSet(generationKey(principal),version,bytes));
    },
    async revoke(principal,id){
      const bytes=await credentialSource(()=>store.get(key(id)));if(!bytes)return;
      const record=credentialJson<CredentialRecord>(bytes);
      if(sessionScope(record.principal)!==sessionScope(principal))deny(403,'Credential owner mismatch');
      await credentialSource(()=>store.put(key(id),Buffer.from(JSON.stringify({...record,revoked:true})),'application/json'));
    },
  };
}

export function createCaptureCredentials({store,prefix='capture-v1',now=Date.now}:{store:ObjectStore;prefix?:string;now?:()=>number}){
  return credentialService(objectCredentialRepository(store,prefix),now);
}
