import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {ConditionalStore,StoreVersion} from '../sessions/types.mjs';
import {z} from 'zod';
const token=z.string().min(1).max(16384);
/** A direct OAuth grant. Its ID is also the connection ID that the grant's source jobs present. */
export const GRANT_ID=/^grant_[a-f0-9]{48}$/;
const schema=z.object({
  id:z.string().regex(GRANT_ID),organizationId:z.string().regex(/^org_[A-Za-z0-9]+$/),
  userId:z.string().regex(/^user_[A-Za-z0-9]+$/),integrationId:z.string().regex(/^int_[a-f0-9]{26}$/),
  provider:z.literal('slack'),status:z.enum(['INITIATED','EXCHANGING','ACTIVE','REFRESHING','FAILED','REVOKED']),
  state:token,callbackUrl:z.string().url().max(4096),flowExpiresAt:z.number().finite(),proxyToken:token,
  accessToken:token.optional(),refreshToken:token.optional(),accessExpiresAt:z.number().finite().optional(),
  remoteRevoked:z.boolean().optional(),version:z.literal(1),
}).strict();
export type ConnectorGrant=z.infer<typeof schema>;
/** AES-256-GCM envelope bound to its storage path, so a sealed object cannot be replayed elsewhere. */
export function sealedEnvelope(key:Uint8Array){
  if(key.length!==32)throw new Error('Invalid credential vault configuration');
  const encryptionKey=Buffer.from(key);
  return {
    seal(path:string,plain:Buffer){
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);
      cipher.setAAD(Buffer.from(path));const body=Buffer.concat([cipher.update(plain),cipher.final()]);
      return Buffer.concat([Buffer.from([1]),iv,cipher.getAuthTag(),body]);
    },
    open(path:string,bytes:Buffer){
      if(bytes[0]!==1||bytes.length<30)throw new Error('Invalid credential envelope');
      const cipher=createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(1,13));cipher.setAAD(Buffer.from(path));cipher.setAuthTag(bytes.subarray(13,29));
      return Buffer.concat([cipher.update(bytes.subarray(29)),cipher.final()]);
    },
  };
}
/** Secrets stay encrypted at rest, including backups; encryption binds the exact organization and key. */
export function credentialVault({store,prefix,organizationId,key}:{store:ConditionalStore;prefix:string;organizationId:string;key:Uint8Array}){
  if(key.length!==32||!/^org_[A-Za-z0-9]+$/.test(organizationId)||!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid credential vault configuration');
  const envelope=sealedEnvelope(key);
  const path=(id:string)=>{if(!GRANT_ID.test(id))throw Object.assign(new Error('Invalid connector grant'),{status:404});return `${prefix}/${organizationId}/${id}.enc`;};
  const validate=(value:unknown,id:string)=>{const record=schema.parse(value);if(record.id!==id||record.organizationId!==organizationId)throw new Error('Credential ownership mismatch');return record;};
  const encode=(record:ConnectorGrant)=>{validate(record,record.id);return envelope.seal(path(record.id),Buffer.from(JSON.stringify(record)));};
  const decode=(bytes:Buffer,id:string)=>validate(JSON.parse(envelope.open(path(id),bytes).toString()),id);
  return {
    async read(id:string){const current=await store.readVersion(path(id),{maxBytes:65536});return {version:current.version,record:current.data?decode(current.data,id):null};},
    async write(record:ConnectorGrant,version:StoreVersion|null){if(!await store.compareAndSet(path(record.id),version,encode(record)))throw Object.assign(new Error('Connector credentials changed; retry'),{status:409});},
  };
}
