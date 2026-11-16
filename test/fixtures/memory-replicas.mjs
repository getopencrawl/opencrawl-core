import {randomUUID} from 'node:crypto';
import {replicasConnectionSchema,replicasChallengeSchema} from '../../dist/src/identity/replicas-connections.mjs';
const clone=value=>value==null?null:structuredClone(value);
export function memoryReplicasState(){
 const connections=new Map(),setups=new Map();
 const read=(values,key)=>{const value=values.get(key);return {record:clone(value?.record),version:value?.version??null};};
 const save=(values,key,version,record)=>{if((values.get(key)?.version??null)!==version)return false;values.set(key,{record:clone(record),version:randomUUID()});return true;};
 return {connections,setups,
  async readConnection(org){return read(connections,org);},
  async saveConnection(org,version,input){const record=replicasConnectionSchema.parse(input);if(record.organizationId!==org||record.installations.some(item=>item.tenantId!==record.tenantId))throw Error('Invalid Replicas scope');const current=connections.get(org);if(current&&current.record.tenantId!==record.tenantId)return false;return save(connections,org,version,record);},
  async listConnections(tenant){return [...connections.values()].map(value=>clone(value.record)).filter(value=>value.tenantId===tenant);},
  async readSetup(hash){return read(setups,hash);},
  async saveSetup(hash,version,record){return save(setups,hash,version,replicasChallengeSchema.parse(record));},
 };
}
