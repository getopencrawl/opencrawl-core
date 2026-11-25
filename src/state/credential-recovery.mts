import {isDeepStrictEqual} from 'node:util';
import {credentialSource,credentialDigest} from '../sessions/credentials.mjs';
import {digest,sessionScope} from '../sessions/event-identity.mjs';
import type {ObjectStore,StoreVersion} from '../sessions/types.mjs';
import {credentialPrefix,type CredentialFamily} from './credential-inventory.mjs';

/** Confirmation refers to the provider's terminal outcome and the stopped
 * producer. A timeout, a quiet interval or a matching read cannot prove either. */
export interface CredentialWriteEvidence {
  writersDrained:true;
  terminal:'applied'|'not-applied'|'not-dispatched';
  reference:string;
}
export interface CredentialWriteIntent {
  family:CredentialFamily;kind:'issue'|'revoke'|'rotate';object_id:string;request_owner:string;
  intended_hash:string|null;base_generation:string|null;expected_version:StoreVersion|null;conditional:boolean;
}

/** Inspect just the named source and verify the operation's security result.
 * No bearer is generated and no source object is written by recovery. */
export async function verifyRecoveredCredentialWrite(store:ObjectStore,root:string,intent:CredentialWriteIntent,evidence:CredentialWriteEvidence){
  if(evidence?.writersDrained!==true || !['applied','not-applied','not-dispatched'].includes(evidence.terminal) ||
    typeof evidence.reference!=='string'||!evidence.reference.trim())throw Error('Credential writer drain and terminal provider evidence required');
  if(!intent.intended_hash){
    if(evidence.terminal!=='not-dispatched')throw Error('Credential source dispatch did not start');
    return;
  }
  if(evidence.terminal==='not-dispatched')throw Error('Credential dispatch must be reconciled against the provider');
  const family=credentialPrefix(root,intent.family);
  const path=family+(intent.kind==='rotate'?'/_credential-generations/':'/_credentials/')+intent.object_id+'.json';
  const read=()=>credentialSource(()=>store.readVersion(path,{maxBytes:intent.kind==='rotate'?1024:64*1024}));
  const first=await read(),second=await read();
  if(!isDeepStrictEqual(first,second) || (first.data===null)!==(first.version===null))throw Error('Credential recovery source is unstable');
  if(first.data && digest(first.data)===intent.intended_hash)return;
  if(!first.data){
    if(intent.kind==='issue' && evidence.terminal==='not-applied' || intent.kind==='revoke' ||
      intent.kind==='rotate' && intent.conditional && intent.expected_version!==null)return;
    throw Error('Credential revocation must be reconciled before releasing the intent');
  }
  let value;
  try{value=JSON.parse(first.data.toString());}catch{throw Error('Invalid credential recovery source');}
  if(intent.kind==='rotate'){
    if(!credentialDigest(value?.generation))throw Error('Invalid credential recovery marker');
    if(value.generation!==intent.base_generation || intent.conditional && first.version!==intent.expected_version)return;
  }else if(value?.id===intent.object_id && value.schemaVersion===1 && value.revoked===true && sessionScope(value.principal)===intent.request_owner)return;
  throw Error('Credential revocation must be reconciled before releasing the intent');
}
