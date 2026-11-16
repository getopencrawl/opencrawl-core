import {randomBytes,randomUUID} from 'node:crypto';
import {sessionScope} from '../../dist/src/sessions/event-identity.mjs';
import {captureCredentialSchema} from '../../dist/src/state/account-state.mjs';
import {parseValueReport} from '../../dist/src/application/value-report.mjs';
const clone=value=>value==null?null:structuredClone(value);
export function memoryAccountState(){
 const credentialRecords=new Map(),generations=new Map(),receipts=new Map(),roleRecords=new Map();
 return {credentialRecords,generations,receipts,roleRecords,
  credentials:{
   async create(input){const record=captureCredentialSchema.parse(input),owner=sessionScope(record.principal);if(credentialRecords.has(record.id))throw Error('Credential exists');credentialRecords.set(record.id,{...record,generation:generations.get(owner)||''});},
   async authenticate(id){const record=credentialRecords.get(id);return record&&(record.generation||'')===(generations.get(sessionScope(record.principal))||'')?clone(record):null;},
   async revokeAll(principal){generations.set(sessionScope(principal),randomBytes(32).toString('hex'));},
   async revoke(principal,id){const record=credentialRecords.get(id);if(!record)return;if(sessionScope(record.principal)!==sessionScope(principal))throw Object.assign(Error('Credential owner mismatch'),{status:403});record.revoked=true;},
  },
  onboarding:{async read(owner,kind){return clone(receipts.get(JSON.stringify([owner,kind])));},async write(owner,kind,value){receipts.set(JSON.stringify([owner,kind]),clone(value));}},
  roles:{async acquire(organizationId,actorId,userId,role){
   if(roleRecords.get(organizationId)?.state==='held')throw Object.assign(Error('Another team change is in progress or awaiting verification'),{status:409,expose:true});
   const operationId=randomUUID();roleRecords.set(organizationId,{schemaVersion:1,state:'held',operationId,organizationId,actorId,userId,role,startedAt:new Date().toISOString()});
   return {async release(){const current=roleRecords.get(organizationId);if(current?.operationId!==operationId||current.state!=='held')throw Object.assign(Error('Team changes need a workspace operator check before continuing.'),{status:503,expose:true});roleRecords.set(organizationId,{schemaVersion:1,state:'idle',operationId,completedAt:new Date().toISOString()});}};
  }},
 };
}
export function memoryConnectorSecrets(){
 const records=new Map(),key=scope=>JSON.stringify([scope.kind,scope.organizationId,scope.id]);
 return {records,async read(scope,aad){const value=records.get(key(scope));if(value&&value.aad!==aad)throw Error('Connector secret binding mismatch');return {version:value?.version??null,data:value?Buffer.from(value.data):null};},
  async compareAndSet(scope,aad,version,data){const k=key(scope),current=records.get(k);if((current?.version??null)!==version||current&&current.aad!==aad)return false;records.set(k,{aad,version:randomUUID(),data:Buffer.from(data)});return true;}};
}
export function memoryValueReports(){const records=new Map();return {records,async read(tenant){const value=records.get(tenant);return value?parseValueReport(JSON.stringify(value)):null;},async write(tenant,value){if(!parseValueReport(JSON.stringify(value)))throw Error('Unsupported value report');records.set(tenant,clone(value));}};}
