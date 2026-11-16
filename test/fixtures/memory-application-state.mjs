import {memorySetupState} from './memory-setup-state.mjs';
import {memoryAccountState,memoryConnectorSecrets,memoryValueReports} from './memory-account-state.mjs';
import {memoryReplicasState,memoryDevinState} from './memory-replicas.mjs';
import {randomUUID} from 'node:crypto';
import {memorySlackCaptureState} from './memory-slack-capture.mjs';
import {resourceControlIdentity} from '../../dist/src/state/resource-controls.mjs';
import {digest} from '../../dist/src/connectors/scope.mjs';
import {digest as sessionDigest,sessionScope,eventIdentityLocation,eventFingerprints,eventIdentityConflict} from '../../dist/src/sessions/event-identity.mjs';
import {isSessionHarness} from '../../dist/src/sessions/types.mjs';
/** Domain tests inject this explicit volatile port. Runtime has no object-store
 * fallback. Repository/concurrency/upgrade tests exercise real PostgreSQL. */
export function memoryApplicationState(){
  const values=new Map(),fences=new Map(),receipts=new Map(),deletions=new Map(),namespace='memory-test-'+randomUUID();
  const controlKey=identity=>JSON.stringify([identity.tenantHash,identity.userHash,identity.kind,identity.harness,identity.resourceHash]);
  const copy=value=>value==null?null:structuredClone(value);
  const controls={
    async readIdentity(identity){return copy(values.get(controlKey(identity)));},
    async read(owner,kind,harness,name){return copy(values.get(controlKey(resourceControlIdentity(owner,kind,harness,name))));},
    async readSource(source){return copy(values.get(controlKey({...source,kind:'sessions',resourceHash:source.sessionHash})));},
    async update(owner,kind,harness,name,change){
      const key=controlKey(resourceControlIdentity(owner,kind,harness,name)),current=values.get(key),next={...change(copy(current)),schemaVersion:1,updatedAt:new Date().toISOString()};
      if(current?.deletedAt&&current.deletedAt!==next.deletedAt||current?.deletion?.state==='complete'&&next.deletion?.state!=='complete')throw Object.assign(new Error('Deletion cannot reopen'),{status:403});
      values.set(key,copy(next));return copy(next);
    },
    async list(owner,kind,harness){const scope=resourceControlIdentity(owner,kind,harness,'inventory'),result=new Map();for(const [key,value]of values){const [tenantHash,userHash,k,h,resourceHash]=JSON.parse(key);if(tenantHash===scope.tenantHash&&userHash===scope.userHash&&k===kind&&h===harness)result.set(resourceHash,copy(value));}return result;},
    async importControl(identity,value){const key=controlKey(identity);if(values.has(key)&&JSON.stringify(values.get(key))!==JSON.stringify(value))throw new Error('Control differs');values.set(key,copy(value));},
  };
  const eventSessions=new Map(),deletedEvents=new Set();
  const resource=source=>source.replace(/\/[a-f0-9]{64}\/([a-f0-9]{64})\/$/,'/$1/');
  const eventIdentities={async reserve(options){
    const where=eventIdentityLocation(options);if(deletedEvents.has(resource(where.source)))throw Object.assign(new Error('Session was deleted'),{status:410});
    const conflicts=new Set(),incoming=eventFingerprints(options.events,conflicts),existing=eventSessions.get(where.source)??new Map();
    for(const [id,hash]of incoming)if(existing.has(id)&&existing.get(id)!==hash)conflicts.add(id);
    if(conflicts.size)eventIdentityConflict(conflicts);
    for(const [id,hash]of incoming)existing.set(id,hash);eventSessions.set(where.source,existing);return {reservedEvents:existing.size};
  },async purgeSession(options){const where=eventIdentityLocation({...options,installationId:'purge'}),scope=resource(where.source);deletedEvents.add(scope);for(const key of eventSessions.keys())if(resource(key)===scope)eventSessions.delete(key);}};
  return {namespace,eventIdentities,setup:memorySetupState(),accounts:memoryAccountState(),connectorSecrets:memoryConnectorSecrets(),replicas:memoryReplicasState(),devin:memoryDevinState(),valueReports:memoryValueReports(),controls,slackCapture:memorySlackCaptureState(),receiptValues:receipts,deletionRecords:deletions,
    indexingReceipts:{async read(key){return copy(receipts.get(key));},async put(key,value){if(!receipts.has(key))receipts.set(key,copy(value));}},
    writeBarrier({namespace:scope='selfhost',tenantId,connectionId,controlPrefix='control/connectors/write-barriers/v1/',now=Date.now}){
      if(![scope,tenantId,connectionId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_:-]{1,200}$/.test(v)))throw new Error('Explicit write-fence scope is required');
      const key=controlPrefix+digest([scope,tenantId,connectionId])+'.json';
      const current=()=>{let value=fences.get(key);if(!value){value={closedAt:null,writers:[]};fences.set(key,value);}return value;};
      const snapshot=()=>{const value=current();return {closed:value.closedAt!==null,closedAt:value.closedAt,pending:value.writers.filter(w=>w.phase==='writing').length,writers:copy(value.writers)};};
      return {key,scope:{namespace:scope,tenantId,connectionId},async inspect(){return snapshot();},async close(){current().closedAt??=now();current().writers=current().writers.filter(w=>w.phase!=='settled');return snapshot();},
        async run(operation,write,{target='unspecified'}={}){
          const value=current();if(value.closedAt!==null)throw Object.assign(new Error('Resource writes are closed'),{status:403,permanent:true});
          const writer={id:randomUUID(),operation,phase:'writing',startedAt:now(),instance:namespace,target};value.writers.push(writer);
          try{const result=await write();value.writers=value.writers.filter(w=>w.id!==writer.id);return result;}
          catch(error){if(error.writeOutcome==='not-applied'){value.writers=value.writers.filter(w=>w.id!==writer.id);throw error;}throw Object.assign(new Error('Resource write outcome is uncertain'),{cause:error,code:'CONNECTOR_WRITE_PENDING',status:503,writeId:writer.id});}
        }};
    },
    deletionRequests(prefix){
      const root=prefix+'/_deletions/v1/',identity=(owner,session)=>{sessionScope(owner);if(!isSessionHarness(session.harness)||!/^[A-Za-z0-9_.:-]{1,200}$/.test(session.sessionId))throw new Error('Invalid session deletion request');return root+sessionDigest(JSON.stringify([prefix,owner.tenantId,owner.userId,session.harness,session.sessionId]))+'.json';};
      const check=key=>{if(!key.startsWith(root)||!/^[a-f0-9]{64}\.json$/.test(key.slice(root.length)))throw Object.assign(new Error('Session deletion scope denied'),{permanent:true});};
      const read=async key=>{check(key);const value=copy(deletions.get(key));if(value&&identity(value.owner,value)!==key)throw new Error('Session deletion identity mismatch');return value;};
      return {read,readFor:(owner,session)=>read(identity(owner,session)),async put(owner,session){if(owner.captureAccess!==undefined)throw Object.assign(new Error('Deletion requires owner access'),{status:403});const key=identity(owner,session);deletions.set(key,{schemaVersion:1,owner:{tenantId:owner.tenantId,userId:owner.userId},...session});return key;},async list(cursor){if(cursor)check(cursor);const keys=[...deletions.keys()].filter(key=>key.startsWith(root)&&(!cursor||key>cursor)).sort();return {keys:keys.slice(0,50),cursor:keys.length>50?keys[49]:null};},async remove(key){check(key);deletions.delete(key);}};
    },
  };
}
const stores=new WeakMap();
export function stateFor(input){
  if(input?.state)return input.state;
  const key=input?.store??input;
  if(!key||!['object','function'].includes(typeof key))throw new Error('Explicit domain test state identity required');
  if(!stores.has(key))stores.set(key,memoryApplicationState());return stores.get(key);
}
export function withTestState(input){
  if(typeof input==='function')return async(...args)=>withTestState(await input(...args));
  const state=stateFor(input),value={...input,state,eventIdentities:input.eventIdentities??state.eventIdentities};
  for(const name of ['resolve','resolveDeletion'])if(typeof input[name]==='function')value[name]=async(...args)=>withTestState(await input[name](...args));
  return value;
}
