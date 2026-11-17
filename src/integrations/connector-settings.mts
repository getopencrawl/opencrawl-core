import type {ConditionalStore,StoreVersion} from '../sessions/types.mjs';
import {z} from 'zod';
import {sealedEnvelope} from './credential-vault.mjs';
const schema=z.object({
  version:z.literal(1),organizationId:z.string().regex(/^org_[A-Za-z0-9]+$/),
  broker:z.object({apiKey:z.string().min(1).max(1024),savedAt:z.string().max(40),savedBy:z.string().regex(/^user_[A-Za-z0-9]+$/)}).strict().nullable(),
}).strict();
export type ConnectorSettings=z.infer<typeof schema>;
/**
 * Connector credentials an admin enters in the product, instead of the server environment.
 * Encrypted at rest and in backups with the connector key; never returned to a browser.
 */
export function connectorSettingsStore({store,prefix,organizationId,key}:{store:ConditionalStore;prefix:string;organizationId:string;key:Uint8Array}){
  if(!/^org_[A-Za-z0-9]+$/.test(organizationId)||!prefix||prefix.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid connector settings configuration');
  const envelope=sealedEnvelope(key),path=`${prefix}/${organizationId}/settings.enc`;
  const validate=(value:unknown)=>{const record=schema.parse(value);if(record.organizationId!==organizationId)throw new Error('Connector settings ownership mismatch');return record;};
  return {
    async read():Promise<{version:StoreVersion|null;record:ConnectorSettings|null}>{
      const current=await store.readVersion(path,{maxBytes:65536});
      return {version:current.version,record:current.data?validate(JSON.parse(envelope.open(path,current.data).toString())):null};
    },
    async write(record:ConnectorSettings,version:StoreVersion|null){
      if(!await store.compareAndSet(path,version,envelope.seal(path,Buffer.from(JSON.stringify(validate(record))))))throw Object.assign(new Error('Connector settings changed; retry'),{status:409});
    },
  };
}
