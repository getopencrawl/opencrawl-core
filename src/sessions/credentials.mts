import {randomBytes} from 'node:crypto';
import type {Principal, ObjectStore, StoreVersion} from './types.mjs';
import {parseJson} from './types.mjs';
import {digest,sessionScope} from './ingest.mjs';
import {fail as deny} from '../errors.mjs';

export interface CredentialRecord {
  schemaVersion:1;id:string;principal:Principal;expiresAt:string;revoked:boolean;revokedAt?:string;generation?:string;
}
export interface CredentialRepository {
  create(record:CredentialRecord):Promise<void>;
  lookup(id:string,clock:()=>number):Promise<{principal:Principal;expiresAt:string}|null>;
  removalVersion(principal:Principal):Promise<StoreVersion|null>;
  rotate(principal:Principal,version?:StoreVersion|null):Promise<void>;
  revoke(principal:Principal,id:string):Promise<void>;
}

export const isCaptureCredential=(token:unknown):token is string=>typeof token==='string' && /^occ1_[a-f0-9]{64}$/.test(token);
export const credentialDigest=(id:unknown):id is string=>typeof id==='string' && /^[a-f0-9]{64}$/.test(id);

export function checkedCredentialRecord(value:unknown,id:string){
  if(!value || typeof value!=='object' || Array.isArray(value))throw Error('Invalid retained credential record');
  const r=value as CredentialRecord,p=r.principal;
  if(Object.keys(r).some(k=>!['schemaVersion','id','principal','expiresAt','revoked','revokedAt','generation'].includes(k)) ||
    r.schemaVersion!==1 || r.id!==id || typeof r.revoked!=='boolean' || typeof r.expiresAt!=='string' || !Number.isFinite(Date.parse(r.expiresAt)) ||
    ('revokedAt' in r && typeof r.revokedAt!=='string') || ('generation' in r && r.generation!=='' && !credentialDigest(r.generation)) ||
    !p || typeof p!=='object' || Array.isArray(p) || Object.keys(p).some(k=>!['tenantId','userId','name','email'].includes(k)) ||
    [p.name,p.email].some(v=>v!=null && typeof v!=='string'))throw Error('Invalid retained credential record');
  sessionScope(p);return r;
}

/** Bearers are generated and hashed at the service boundary. Storage never receives a bearer. */
export function credentialService(repository:CredentialRepository,now=Date.now) {
  function manage(principal:Principal){
    sessionScope(principal);
    if(principal.captureAccess==='write')deny(403,'Capture credentials cannot manage credentials');
  }
  return {
    async issue(principal:Principal){
      sessionScope(principal);
      if(principal.captureAccess==='write')deny(403,'Capture credentials cannot delegate access');
      const token='occ1_'+randomBytes(32).toString('hex'),id=digest(token);
      const expiresAt=new Date(now()+365*86400000).toISOString();
      await repository.create({schemaVersion:1,id,principal:{tenantId:principal.tenantId,userId:principal.userId,
        name:principal.name??null,email:principal.email??null},expiresAt,revoked:false});
      return {id,token,expiresAt,access:'capture-write'};
    },
    async authenticate(token:string){
      if(!isCaptureCredential(token))return null;
      const found=await repository.lookup(digest(token),now);
      return found && Date.parse(found.expiresAt)>now() ? {...found.principal,captureAccess:'write'} : null;
    },
    async removalVersion(principal:Principal){manage(principal);return repository.removalVersion(principal);},
    async revokeVersion(principal:Principal,version:StoreVersion|null){
      manage(principal);
      if(version!==null && !(typeof version==='string' && version.length || typeof version==='number' && Number.isFinite(version)))deny(400,'Invalid credential removal version');
      await repository.rotate(principal,version);
    },
    async revokeAll(principal:Principal){manage(principal);await repository.rotate(principal);},
    async revoke(principal:Principal,id:string){
      manage(principal);if(!credentialDigest(id))deny(400,'Invalid credential ID');
      await repository.revoke(principal,id);return {revoked:true};
    },
  };
}

/** Object transport messages can include a credential digest or an owner path. */
export async function credentialSource<T>(run:()=>Promise<T>):Promise<T>{
  try{return await run();}catch(caught){
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
    const value=parseJson<{generation?:unknown}>(bytes).generation;
    if(!credentialDigest(value))deny(503,'Credential revocation state unavailable');
    return value;
  }
  return {
    async create(record){
      const bytes=Buffer.from(JSON.stringify({...record,generation:await generation(record.principal)}));
      await credentialSource(()=>store.put(key(record.id),bytes,'application/json'));
    },
    async lookup(id){
      const bytes=await credentialSource(()=>store.get(key(id)));if(!bytes)return null;
      const record=parseJson<CredentialRecord>(bytes);
      if(record.schemaVersion!==1 || record.id!==id || record.revoked || !Number.isFinite(Date.parse(record.expiresAt)))return null;
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
      const record=parseJson<CredentialRecord>(bytes);
      if(sessionScope(record.principal)!==sessionScope(principal))deny(403,'Credential owner mismatch');
      await credentialSource(()=>store.put(key(id),Buffer.from(JSON.stringify({...record,revoked:true})),'application/json'));
    },
  };
}

export function createCaptureCredentials({store,prefix='capture-v1',now=Date.now}:{store:ObjectStore;prefix?:string;now?:()=>number}){
  return credentialService(objectCredentialRepository(store,prefix),now);
}
