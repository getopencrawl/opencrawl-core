import {randomUUID} from 'node:crypto';
import {workloadConnectionSchema,replicasChallengeSchema,devinChallengeSchema} from '../../dist/src/identity/workload-schema.mjs';
const clone=value=>value==null?null:structuredClone(value);
export const memoryReplicasState=()=>memoryWorkloadState('replicas',replicasChallengeSchema);
export const memoryDevinState=()=>memoryWorkloadState('devin',devinChallengeSchema);
function memoryWorkloadState(provider,challengeSchema){
 const connectionSchema=workloadConnectionSchema(provider);
 const connections=new Map(),setups=new Map();
 const read=(values,key)=>{const value=values.get(key);return {record:clone(value?.record),version:value?.version??null};};
 const save=(values,key,version,record)=>{if((values.get(key)?.version??null)!==version)return false;values.set(key,{record:clone(record),version:randomUUID()});return true;};
 return {connections,setups,
  async readConnection(org){return read(connections,org);},
  async saveConnection(org,version,input){const record=connectionSchema.parse(input);if(record.organizationId!==org||record.installations.some(item=>item.tenantId!==record.tenantId))throw Error('Invalid workload scope');const current=connections.get(org);if(current&&current.record.tenantId!==record.tenantId)return false;return save(connections,org,version,record);},
  async listConnections(tenant){return [...connections.values()].map(value=>clone(value.record)).filter(value=>value.tenantId===tenant);},
  async readSetup(hash){return read(setups,hash);},
  async saveSetup(hash,version,record){return save(setups,hash,version,challengeSchema.parse(record));},
 };
}
