import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {ConditionalStore,StoreVersion} from '../sessions/types.mjs';
import {z} from 'zod';
const token=z.string().min(1).max(16384);
const schema=z.object({
  id:z.string().regex(/^grant_[a-f0-9]{48}$/),organizationId:z.string().regex(/^org_[A-Za-z0-9]+$/),
  userId:z.string().regex(/^user_[A-Za-z0-9]+$/),integrationId:z.string().regex(/^int_[a-f0-9]{26}$/),
  provider:z.literal('slack'),status:z.enum(['INITIATED','EXCHANGING','ACTIVE','REFRESHING','FAILED','REVOKED']),
  state:token,callbackUrl:z.string().url().max(4096),flowExpiresAt:z.number().finite(),proxyToken:token,
  accessToken:token.optional(),refreshToken:token.optional(),accessExpiresAt:z.number().finite().optional(),
  remoteRevoked:z.boolean().optional(),version:z.literal(1),
}).strict();
export type ConnectorGrant=z.infer<typeof schema>;
/** Secrets stay encrypted at rest, including backups; encryption binds the exact organization and key. */
export function credentialVault({store,prefix,organizationId,key}:{store:ConditionalStore;prefix:string;organizationId:string;key:Uint8Array}){
  if(key.length!==32||!/^org_[A-Za-z0-9]+$/.test(organizationId)||!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid credential vault configuration');
  const encryptionKey=Buffer.from(key);
  const path=(id:string)=>{if(!/^grant_[a-f0-9]{48}$/.test(id))throw Object.assign(new Error('Invalid connector grant'),{status:404});return `${prefix}/${organizationId}/${id}.enc`;};
  const validate=(value:unknown,id:string)=>{const record=schema.parse(value);if(record.id!==id||record.organizationId!==organizationId)throw new Error('Credential ownership mismatch');return record;};
  function encode(record:ConnectorGrant){
    validate(record,record.id);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
    cipher.setAAD(Buffer.from(path(record.id)));const body=Buffer.concat([cipher.update(JSON.stringify(record)),cipher.final()]);
    return Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),body]);
  }
  function decode(bytes:Buffer,id:string){
    if(bytes[0]!==1||bytes.length<30)throw new Error('Invalid credential envelope');
    const cipher=createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(1,13));cipher.setAAD(Buffer.from(path(id)));cipher.setAuthTag(bytes.subarray(13,29));
    return validate(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)),cipher.final()]).toString()),id);
  }
  return {
    async read(id:string){const current=await store.readVersion(path(id),{maxBytes:65536});return {version:current.version,record:current.data?decode(current.data,id):null};},
    async write(record:ConnectorGrant,version:StoreVersion|null){if(!await store.compareAndSet(path(record.id),version,encode(record)))throw Object.assign(new Error('Connector credentials changed; retry'),{status:409});},
  };
}
