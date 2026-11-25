import {createHash} from 'node:crypto';
import type {ObjectStore, StoreVersion} from '../sessions/types.mjs';
import {challengeSchema, connectionSchema, scope, uuid, type ReplicasConnection, type ReplicasChallenge} from '../identity/replicas-schema.mjs';

export type ReplicasObjects = Pick<ObjectStore,'get'|'readVersion'|'compareAndSet'|'put'|'listPage'>;
type Version = StoreVersion | null;
type Versioned<T> = {record:T|null;version:Version};

export interface ReplicasRepository {
  readConnection(id:string):Promise<Versioned<ReplicasConnection>>;
  saveConnection(id:string,version:Version,record:ReplicasConnection):Promise<boolean>;
  listConnections(tenant:string):Promise<ReplicasConnection[]>;
  readSetup(hash:string):Promise<Versioned<ReplicasChallenge>>;
  saveSetup(hash:string,version:Version,record:ReplicasChallenge):Promise<boolean>;
}

export function checkedConnection(id:string,value:unknown) {
  const record=connectionSchema.parse(value);
  if (record.organizationId!==uuid.parse(id) || record.installations.some(row=>row.tenantId!==record.tenantId))
    throw new Error('Invalid Replicas connection scope');
  return record;
}

export function codeHash(hash:string) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid Replicas setup hash');
  return hash;
}

export const tenantHash=(tenant:string)=>createHash('sha256').update(scope.parse(tenant)).digest('hex');

/** Existing organization records determine ownership; the secondary index only locates them. */
export function objectReplicasState(store:ReplicasObjects,prefix:string):ReplicasRepository {
  const root=prefix+'/identity/replicas-v1/';
  const orgKey=(id:string)=>root+'organizations/'+uuid.parse(id)+'.json';
  const setupKey=(hash:string)=>root+'setup/'+codeHash(hash)+'.json';
  const tenantPrefix=(tenant:string)=>root+'tenants/'+tenantHash(tenant)+'/';
  async function readConnection(id:string) {
    const {data,version}=await store.readVersion(orgKey(id),{maxBytes:65536});
    return {record:data ? checkedConnection(id,JSON.parse(data.toString())) : null,version};
  }
  return {
    readConnection,
    async saveConnection(id,version,input) {
      const record=checkedConnection(id,input);
      if (!await store.compareAndSet(orgKey(id),version,Buffer.from(JSON.stringify(record)))) return false;
      if (!record.revokedAt) await store.put(tenantPrefix(record.tenantId)+id+'.json',Buffer.from(JSON.stringify({organizationId:id})),'application/json');
      return true;
    },
    async listConnections(tenant) {
      const path=tenantPrefix(tenant),result:ReplicasConnection[]=[];
      let cursor:string|undefined;
      for (let page=0;page<100;page++) {
        const listed=await store.listPage(path,{maxKeys:100,continuationToken:cursor});
        for (const key of listed.keys) {
          if (!key.startsWith(path)||!key.endsWith('.json')) throw new Error('Invalid Replicas index key');
          const {record}=await readConnection(key.slice(path.length,-5));
          if (record && record.tenantId===tenant && !record.revokedAt) result.push(record);
        }
        if (!listed.nextToken) return result;
        if (cursor===listed.nextToken) throw new Error('Incomplete Replicas index');
        cursor=listed.nextToken;
      }
      throw new Error('Replicas connection listing exceeds limit');
    },
    async readSetup(hash) {
      const {data,version}=await store.readVersion(setupKey(hash),{maxBytes:4096});
      return {record:data ? challengeSchema.parse(JSON.parse(data.toString())) : null,version};
    },
    saveSetup:(hash,version,record)=>store.compareAndSet(setupKey(hash),version,Buffer.from(JSON.stringify(challengeSchema.parse(record)))),
  };
}
