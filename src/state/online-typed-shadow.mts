import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createLegacyObjectClassifier} from './legacy-object-classification.mjs';
import {createOnlineProjection,onlineProjectionHash} from './online-projection.mjs';
import {createOnlineRetirements} from './online-retirements.mjs';
import {createOnlineShadow,type OnlineShadowListing,type OnlineShadowParticipant,type OnlineShadowSelection} from './online-shadow.mjs';
import type {OnlineExternalStore,createOnlineJournal} from './online-journal.mjs';
import type {OnlineMigrationBinding} from './online-temporal/types.mjs';

type ProjectionOptions=Omit<Parameters<typeof createOnlineProjection>[0],'epoch'|'sourceId'|'journalBinding'>;
export type OnlineTypedDisposition=OnlineShadowSelection|{kind:'blocked';domain:string;maxBytes:number};
const typed=new Set(['resource-controls','capture-credentials','credential-generations','onboarding','role-writes','connector-grants','connector-settings','replicas-connections','replicas-index','replicas-setup','value-reports','board','session-write-fences','connector-write-fences','deletion-requests','slack-capture']);
function fail(code:string):never{throw Object.assign(new Error('Online typed shadow: '+code),{code:'ONLINE_TYPED_SHADOW_'+code});}
const compare=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
/** Background migration only. The physical listing MUST include retained
 * tombstones. Typed repositories and byte evidence commit on the journal's real
 * transaction client. Retired derived state uses metadata, never a body mirror.
 *
 * Completed background parity is an observation, not final fenced admission.
 * Baseline coverage receipts and compact incremental final proof remain separate
 * composition work; this factory cannot mark an installation ready. */
export function createOnlineTypedShadow({binding:inputBinding,journal,external,physicalListing,assertCurrent,retireDerived,...input}:ProjectionOptions&{
 binding:OnlineMigrationBinding;journal:ReturnType<typeof createOnlineJournal>;external:OnlineExternalStore;
 physicalListing:OnlineShadowListing;assertCurrent:(signal:AbortSignal)=>Promise<void>;retireDerived?:true;
}){
 const binding=Object.freeze({...inputBinding});
 if(retireDerived!==undefined&&retireDerived!==true)fail('INVALID_RETIREMENT_POLICY');
 if(!input.store.bucket||!Array.isArray(input.registryRecords)||input.registryRecords.length>100000)fail('INVALID_SOURCE_BINDING');
 const encoded=JSON.stringify(input.registryRecords);if(Buffer.byteLength(encoded)>8*1024*1024)fail('REGISTRY_SCOPE_LIMIT');
 const registryRecords=JSON.parse(encoded) as ProjectionOptions['registryRecords'];
 const options={...input,tenantIds:[...input.tenantIds],retiredTenantHashes:[...(input.retiredTenantHashes??[])],registryRecords};
 const projection=createOnlineProjection({...options,epoch:binding.epoch,sourceId:binding.sourceId,journalBinding:journal.binding});
 const classifier=createLegacyObjectClassifier({prefix:options.prefix,credentialPurpose:options.credentialPurpose});
 const retirements=retireDerived?createOnlineRetirements({database:options.database,epoch:binding.epoch,sourceId:binding.sourceId,journalBinding:journal.binding,source:{bucket:options.store.bucket!,prefix:options.prefix},registryRecords,tenantIds:options.tenantIds}):undefined;
 if(retirements&&(retirements.binding.namespace!==options.database.namespace||retirements.binding.epoch!==binding.epoch||retirements.binding.sourceId!==binding.sourceId||retirements.source.bucket!==options.store.bucket||retirements.source.prefix!==options.prefix))fail('RETIREMENT_BINDING_MISMATCH');
 const identity=onlineProjectionHash({format:1,projection:projection.binding,registryScopeHash:createHash('sha256').update(encoded).digest('hex'),retirementPolicyHash:retirements?.binding.policyHash??null});
 function disposition(key:string):OnlineTypedDisposition{
  const found=classifier.classify(key);if(!found)return {kind:'immutable'};
  const retirement=retirements?.classify(key);
  if(retirement){if(retirement.domain!==found.domain||retirement.maxBytes!==found.maxBytes)fail('RETIREMENT_CLASSIFICATION_MISMATCH');return {kind:'retired',...retirement};}
  return {kind:typed.has(found.domain)?'retained':'blocked',domain:found.domain,maxBytes:found.maxBytes};
 }
 const participant=Object.freeze<OnlineShadowParticipant>({
  binding:Object.freeze({namespace:options.database.namespace,epoch:binding.epoch,sourceId:binding.sourceId,targetId:binding.targetId,identity}),
  select(key:string){const selected=disposition(key);if(selected.kind==='blocked')fail('UNSUPPORTED_DOMAIN_'+selected.domain);return selected;},
  async ready(){await projection.ready();await retirements?.ready();},
  async backfillIn(client:PoolClient,key:string,value){if(value.deleted||value.bytes===null||value.version===null||value.operationId!==null||value.revision!==null)fail('INVALID_BASELINE');await projection.backfill(client,{key,bytes:value.bytes,version:value.version});},
  async backfillRetiredIn(client:PoolClient,key:string,selected){if(!retirements)fail('RETIREMENT_POLICY_REQUIRED');await retirements.backfillIn(client,{key,domain:selected.domain,scopeHash:selected.scopeHash});},
  async applyIn(client:PoolClient,intent,selected){if(selected.kind==='retained')await projection.apply(client,intent);else{if(!retirements)fail('RETIREMENT_POLICY_REQUIRED');await retirements.applyIn(client,intent,{domain:selected.domain,scopeHash:selected.scopeHash});}},
  async inspectIn(client:PoolClient,key:string,value){if(value.version===null)return false;return projection.inspectIn(client,{key,bytes:value.bytes,version:value.version,operationId:value.operationId,revision:value.revision??'0'});},
  async inspectRetiredIn(client:PoolClient,key:string,selected){if(!retirements)fail('RETIREMENT_POLICY_REQUIRED');return retirements.inspectIn(client,{key,domain:selected.domain,scopeHash:selected.scopeHash});},
  async keysPageIn(client:PoolClient,input:{after:string;limit:number}){
   const a=await projection.keysPageIn(client,input),b=retirements?await retirements.keysPageIn(client,input):[];
   return [...new Set([...a,...b])].sort(compare).slice(0,input.limit);
  },
 });
 const shadow=createOnlineShadow({database:options.database,binding,journal,external,listing:physicalListing,roots:classifier.roots,classify:classifier.classify,assertCurrent,participant});
 const adapter={...shadow.adapter,async parityPage(request:Parameters<typeof shadow.adapter.parityPage>[0]){
  if(request.cursor===null)for(let shard=0;shard<binding.shards;shard++){request.signal.throwIfAborted();const checkpoint=await journal.replayCheckpoint(shadow.bindingId+'-'+shard);if(checkpoint===null||BigInt(checkpoint)<BigInt(request.through))return {cursor:null,processed:0,mismatches:0,drift:true};}
  return shadow.adapter.parityPage(request);
 }};
 return {...shadow,adapter,mode:'background-observation-only' as const,disposition,enrollTenant:projection.enrollTenant,inspectReplicasReferencesPageIn:projection.inspectReplicasReferencesPageIn};
}
