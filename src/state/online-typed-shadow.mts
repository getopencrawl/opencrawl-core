import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {createOnlineObjectPolicy,verifyOnlineNativeDeletionProof,type OnlinePreservedEventIdentities} from './online-object-policy.mjs';
import {createOnlineProjection,onlineProjectionHash} from './online-projection.mjs';
import {createOnlineRetirements} from './online-retirements.mjs';
import {createOnlineShadow,type OnlineShadowListing,type OnlineShadowParticipant,type OnlineShadowSelection} from './online-shadow.mjs';
import type {OnlineExternalStore,OnlineSourceRegistration,createOnlineJournal} from './online-journal.mjs';
import type {OnlineMigrationBinding} from './online-temporal/types.mjs';
import type {OnlineCoveragePolicy} from './online-coverage.mjs';

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
export type OnlineObjectParticipantOptions=ProjectionOptions&{
 binding:OnlineMigrationBinding;journal:ReturnType<typeof createOnlineJournal>;
 retireDerived?:true;coverage?:OnlineCoveragePolicy;preservedEventIdentities?:OnlinePreservedEventIdentities;
};
/** The typed object participant only. Compose it with other source participants
 * under ONE journal/coverage coordinator. The host must include verifyNative in
 * its current-source assertion; this participant never grants admission. */
export function createOnlineObjectParticipant({binding:inputBinding,journal,retireDerived,coverage:coveragePolicy,preservedEventIdentities,...input}:OnlineObjectParticipantOptions){
 const binding=Object.freeze({...inputBinding});
 if(retireDerived!==undefined&&retireDerived!==true)fail('INVALID_RETIREMENT_POLICY');
 if(!input.store.bucket||!Array.isArray(input.registryRecords)||input.registryRecords.length>100000)fail('INVALID_SOURCE_BINDING');
 const encoded=JSON.stringify(input.registryRecords);if(Buffer.byteLength(encoded)>8*1024*1024)fail('REGISTRY_SCOPE_LIMIT');
 const registryRecords=JSON.parse(encoded) as ProjectionOptions['registryRecords'];
 const options={...input,tenantIds:[...input.tenantIds],retiredTenantHashes:[...(input.retiredTenantHashes??[])],registryRecords};
 const projection=createOnlineProjection({...options,epoch:binding.epoch,sourceId:binding.sourceId,journalBinding:journal.binding});
 const classifier=createOnlineObjectPolicy({prefix:options.prefix,credentialPurpose:options.credentialPurpose,agentPrefix:options.agentPrefix,preservedEventIdentities:preservedEventIdentities?.binding});
 const native=classifier.preservedEventIdentities,verifyNativeMetadata=preservedEventIdentities?.verify,readNativeDeletion=preservedEventIdentities?.readDeletionProof;let nativeVerified=false;
 if(native&&(!coveragePolicy||native.applicationNamespace!==options.database.namespace||native.bucket!==options.store.bucket||typeof verifyNativeMetadata!=='function'||native.deletionProofVersion===1&&typeof readNativeDeletion!=='function'||native.deletionProofVersion!==1&&readNativeDeletion!==undefined))fail('INVALID_NATIVE_BINDING');
 async function verifyNative(){
  if(!native)return;nativeVerified=false;
  const proof=await verifyNativeMetadata!();
  if(!proof||Object.keys(proof).sort().join(',')!=='binding,eventRowsCounted,historicalBodiesRead,metadataOnly,rowsWritten'||proof.metadataOnly!==true||proof.historicalBodiesRead!==false||proof.eventRowsCounted!==false||proof.rowsWritten!==false||onlineProjectionHash(proof.binding)!==onlineProjectionHash(native))fail('NATIVE_METADATA_MISMATCH');
  nativeVerified=true;
 }
 const retirements=retireDerived?createOnlineRetirements({database:options.database,epoch:binding.epoch,sourceId:binding.sourceId,journalBinding:journal.binding,source:{bucket:options.store.bucket!,prefix:options.prefix},registryRecords,tenantIds:options.tenantIds}):undefined;
 if(retirements&&(retirements.binding.namespace!==options.database.namespace||retirements.binding.epoch!==binding.epoch||retirements.binding.sourceId!==binding.sourceId||retirements.source.bucket!==options.store.bucket||retirements.source.prefix!==options.prefix))fail('RETIREMENT_BINDING_MISMATCH');
 const identity=onlineProjectionHash({format:1,projection:projection.binding,registryScopeHash:createHash('sha256').update(encoded).digest('hex'),retirementPolicyHash:retirements?.binding.policyHash??null,objectPolicyHash:classifier.policyHash});
 function disposition(key:string):OnlineTypedDisposition{
  const found=classifier.classify(key);if(!found)return {kind:'immutable'};
  if(found.preservedNative)return {kind:'preserved-native',domain:'event-identities',maxBytes:found.maxBytes,nativeBindingHash:classifier.nativeBindingHash!};
  const retirement=classifier.route(key).credentialPurpose==='agent'?null:retirements?.classify(key);
  if(retirement){if(retirement.domain!==found.domain||retirement.maxBytes!==found.maxBytes)fail('RETIREMENT_CLASSIFICATION_MISMATCH');return {kind:'retired',...retirement};}
  return {kind:typed.has(found.domain)?'retained':'blocked',domain:found.domain,maxBytes:found.maxBytes};
 }
 const participant=Object.freeze<OnlineShadowParticipant>({
  binding:Object.freeze({namespace:options.database.namespace,epoch:binding.epoch,sourceId:binding.sourceId,targetId:binding.targetId,identity}),
  select(key:string){const selected=disposition(key);if(selected.kind==='blocked')fail('UNSUPPORTED_DOMAIN_'+selected.domain);return selected;},
  async ready(){await verifyNative();await projection.ready();await retirements?.ready();},
  async backfillIn(client:PoolClient,key:string,value){if(value.deleted||value.bytes===null||value.version===null||value.operationId!==null||value.revision!==null)fail('INVALID_BASELINE');return projection.backfill(client,{key,bytes:value.bytes,version:value.version});},
  async backfillRetiredIn(client:PoolClient,key:string,selected){if(!retirements)fail('RETIREMENT_POLICY_REQUIRED');const scope={key,domain:selected.domain,scopeHash:selected.scopeHash};await retirements.backfillIn(client,scope);const value=await retirements.readIn(client,scope);if(!value)fail('MISSING_RETIREMENT_READBACK');return {targetKey:JSON.stringify(['retirement',selected.domain,key]),targetHash:onlineProjectionHash(value)};},
  async applyIn(client:PoolClient,intent,selected){if(selected.kind==='retained')return projection.apply(client,intent);if(!retirements)fail('RETIREMENT_POLICY_REQUIRED');const scope={key:intent.key,domain:selected.domain,scopeHash:selected.scopeHash};await retirements.applyIn(client,intent,scope);const value=await retirements.readIn(client,scope);if(!value)fail('MISSING_RETIREMENT_READBACK');return {targetKey:JSON.stringify(['retirement',selected.domain,intent.key]),targetHash:onlineProjectionHash(value)};},
  async inspectIn(client:PoolClient,key:string,value){if(value.version===null)return false;return projection.inspectIn(client,{key,bytes:value.bytes,version:value.version,operationId:value.operationId,revision:value.revision??'0'});},
  async inspectRetiredIn(client:PoolClient,key:string,selected){if(!retirements)fail('RETIREMENT_POLICY_REQUIRED');return retirements.inspectIn(client,{key,domain:selected.domain,scopeHash:selected.scopeHash});},
  async inspectNativeIn(client:PoolClient,key:string,selected){
   if(!nativeVerified||selected.nativeBindingHash!==classifier.nativeBindingHash)fail('NATIVE_METADATA_REQUIRED');
   const found=classifier.classify(key);if(!found?.preservedNative||found.domain!=='event-identities'||found.parts.length!==1||!await projection.hasEnrolledTenantHashIn(client,found.parts[0]!))fail('NATIVE_OWNER_MISMATCH');
   // No journal operation is legitimate for the preserved ledger's old marker.
   if((await client.query('SELECT 1 FROM opencrawl_online_migration_journal WHERE namespace=$1 AND epoch=$2 AND source_id=$3 AND source_key=$4 LIMIT 1',[options.database.namespace,binding.epoch,binding.sourceId,key])).rows.length)fail('NATIVE_MARKER_MUTATED');
   return {nativeBindingHash:classifier.nativeBindingHash!};
  },
  async inspectNativeAbsenceIn(client,key,selected,signal){
   signal.throwIfAborted();if(!native||native.deletionProofVersion!==1||!readNativeDeletion)return false;
   await participant.inspectNativeIn!(client,key,selected);signal.throwIfAborted();
   const suffix='event-identities-v1.json';if(!key.endsWith('/'+suffix))fail('INVALID_NATIVE_MARKER');
   const source=key.slice(0,-suffix.length),proof=await readNativeDeletion({prefix:options.prefix,source,signal});signal.throwIfAborted();
   return verifyOnlineNativeDeletionProof(proof,{binding:native,prefix:options.prefix,source});
  },
  async keysPageIn(client:PoolClient,input:{after:string;limit:number}){
   const a=await projection.keysPageIn(client,input),b=retirements?await retirements.keysPageIn(client,input):[];
   return [...new Set([...a,...b])].sort(compare).slice(0,input.limit);
  },
 });
 return {binding,participant,objectPolicy:classifier,disposition,verifyNative,enrollTenant:projection.enrollTenant,inspectReplicasReferencesPageIn:projection.inspectReplicasReferencesPageIn};
}
/** Backward-compatible single-participant convenience factory. */
export function createOnlineTypedShadow({external,physicalListing,assertCurrent,sourceRegistration,...options}:OnlineObjectParticipantOptions&{
 external:OnlineExternalStore;physicalListing:OnlineShadowListing;assertCurrent:(signal:AbortSignal)=>Promise<void>;sourceRegistration?:OnlineSourceRegistration;
}){
 const {binding,participant,objectPolicy:classifier,disposition,verifyNative,enrollTenant,inspectReplicasReferencesPageIn}=createOnlineObjectParticipant(options),journal=options.journal,coveragePolicy=options.coverage;
 const shadow=createOnlineShadow({database:options.database,binding,journal,external,listing:physicalListing,roots:classifier.roots,classify:classifier.classify,assertCurrent:async signal=>{await assertCurrent(signal);await verifyNative();},participant,coveragePolicy,sourceRegistration});
 const adapter={...shadow.adapter,
  async backfillPage(request:Parameters<typeof shadow.adapter.backfillPage>[0]){await verifyNative();return shadow.adapter.backfillPage(request);},
  async replayPage(request:Parameters<typeof shadow.adapter.replayPage>[0]){await verifyNative();return shadow.adapter.replayPage(request);},
  async reconcilePending(request:Parameters<typeof shadow.adapter.reconcilePending>[0]){await verifyNative();return shadow.adapter.reconcilePending(request);},
  async parityPage(request:Parameters<typeof shadow.adapter.parityPage>[0]){
  await verifyNative();
  if(request.cursor===null)for(let shard=0;shard<binding.shards;shard++){request.signal.throwIfAborted();const checkpoint=await journal.replayCheckpoint(shadow.bindingId+'-'+shard);if(checkpoint===null||BigInt(checkpoint)<BigInt(request.through))return {cursor:null,processed:0,mismatches:0,drift:true};}
  return shadow.adapter.parityPage(request);
 }};
 return {...shadow,adapter,async backfill(key:string){await verifyNative();return shadow.backfill(key);},objectPolicy:classifier,mode:'background-observation-only' as const,disposition,enrollTenant,inspectReplicasReferencesPageIn};
}
