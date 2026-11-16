import {createHash} from 'node:crypto';
import {createLegacyObjectClassifier,type LegacyObjectClassification} from './legacy-object-classification.mjs';

export interface OnlineObjectRoute {prefix:string;credentialPurpose:'capture'|'agent'}
export interface OnlinePreservedEventIdentityBinding {
 applicationNamespace:string;databaseId:string;namespace:string;bucket:string;sourceContractHash:string;verifierId:string;
}
export interface OnlinePreservedEventIdentityProof {
 binding:OnlinePreservedEventIdentityBinding;metadataOnly:true;historicalBodiesRead:false;eventRowsCounted:false;rowsWritten:false;
}
export interface OnlinePreservedEventIdentities {
 binding:OnlinePreservedEventIdentityBinding;
 /** Owning metadata verifier only. It must not initialize, recount or import. */
 verify():Promise<OnlinePreservedEventIdentityProof>;
}
export interface OnlineObjectClassification extends LegacyObjectClassification {preservedNative?:true}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(message:string):never{throw new Error('Online object policy: '+message);}
function text(value:unknown,max:number):asserts value is string{if(typeof value!=='string'||!value||value.includes('\0')||Buffer.byteLength(value)>max)fail('invalid native binding');}
export function freezeOnlineNativeBinding(input:OnlinePreservedEventIdentityBinding):Readonly<OnlinePreservedEventIdentityBinding>{
 if(!input||Object.keys(input).sort().join(',')!=='applicationNamespace,bucket,databaseId,namespace,sourceContractHash,verifierId')fail('invalid native binding');
 const {applicationNamespace,databaseId,namespace,bucket,sourceContractHash,verifierId}=input;
 text(applicationNamespace,2048);text(namespace,2048);text(bucket,2048);text(verifierId,512);
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(databaseId)||!/^[a-f0-9]{64}$/.test(sourceContractHash))fail('invalid native binding');
 return Object.freeze({applicationNamespace,databaseId,namespace,bucket,sourceContractHash,verifierId});
}
/** One physical source and journal. The nested agent route and native ledger
 * preservation are explicit policies, never raw-state or body-validation escapes. */
export function createOnlineObjectPolicy({prefix,credentialPurpose='capture',agentPrefix,preservedEventIdentities}:{prefix:string;credentialPurpose?:'capture'|'agent';agentPrefix?:string;preservedEventIdentities?:OnlinePreservedEventIdentityBinding}){
 const primary=Object.freeze({prefix,credentialPurpose}),capture=createLegacyObjectClassifier(primary);
 if(agentPrefix!==undefined&&(credentialPurpose!=='capture'||agentPrefix!==prefix+'/_agent-access'))fail('unsupported agent namespace');
 if(preservedEventIdentities&&credentialPurpose!=='capture')fail('native ledger needs capture scope');
 const native=preservedEventIdentities?freezeOnlineNativeBinding(preservedEventIdentities):undefined,nativeBindingHash=native?digest(native):undefined;
 const agent=agentPrefix===undefined?undefined:Object.freeze({prefix:agentPrefix,credentialPurpose:'agent' as const});
 const agentClassifier=agent?createLegacyObjectClassifier(agent):undefined;
 const routes=Object.freeze([primary,...(agent?[agent]:[])]),roots=Object.freeze([...capture.roots]);
 const policyHash=digest({format:1,routes,...(native?{preservedEventIdentities:native}: {})});
 function route(key:string):Readonly<OnlineObjectRoute>{return agent&&typeof key==='string'&&key.startsWith(agent.prefix+'/')?agent:primary;}
 function classify(key:string):OnlineObjectClassification|null{
  const value=route(key)===agent?agentClassifier!.classify(key):capture.classify(key);
  return value&&native&&route(key)===primary&&value.domain==='event-identities'?{...value,preservedNative:true}:value;
 }
 return Object.freeze({routes,roots,policyHash,route,classify,nativeBindingHash,preservedEventIdentities:native});
}
