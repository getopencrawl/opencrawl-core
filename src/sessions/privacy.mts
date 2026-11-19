import {randomUUID} from 'node:crypto';
import {fail} from '../errors.mjs';
import {digest,sessionScope} from './event-identity.mjs';
import {maskPatterns,secretName,SECRET_MASK,literal} from './credential-patterns.mjs';
import type {ObjectStore, Principal, SessionEvent} from './types.mjs';

import type {PrivacyPreference} from '../application/library-types.mjs';
export function createPrivacyPreferences(store:ObjectStore, prefix:string, eligible:(owner:Principal)=>boolean | Promise<boolean>) {
  async function key(owner:Principal) {
    if (!await eligible(owner)) fail(404,'Session privacy is unavailable');
    return prefix+'/'+sessionScope(owner)+'/preferences/session-privacy.json';
  }
  async function read(owner:Principal):Promise<PrivacyPreference> {
    const data=await store.get(await key(owner),{maxBytes:16384});
    const settings=data ? JSON.parse(data.toString()) : {enabled:true,rules:'',revision:'0'};
    if(typeof settings.enabled!=='boolean'||typeof settings.rules!=='string'||typeof settings.revision!=='string') throw Error('Invalid privacy preference');
    return {...settings,subject:sessionScope(owner)};
  }
  async function change(owner:Principal,input:PrivacyPreference) {
    const path=await key(owner);
    if(input.subject!==sessionScope(owner)) fail(409,'Your workspace or account changed.');
    if(typeof input.enabled!=='boolean'||typeof input.rules!=='string'||input.rules.length>1500) fail(400,'Invalid privacy preference');
    const current=await store.readVersion(path,{maxBytes:16384});
    if((current.data?JSON.parse(current.data.toString()).revision:'0')!==input.revision) fail(409,'Privacy settings changed. Reload and try again.');
    const next={enabled:input.enabled,rules:input.rules.trim(),revision:randomUUID()};
    if(!await store.compareAndSet(path,current.version,Buffer.from(JSON.stringify(next)))) fail(409,'Privacy settings changed. Reload and try again.');
    return {...next,subject:sessionScope(owner)};
  }
  return {eligible,read,change};
}
export type PrivacyPreferences=ReturnType<typeof createPrivacyPreferences>;

// Capture has already identified the author. Keep the original message body,
// including its block structure when the harness supplies structured content.
export function privacyPrompt(event:SessionEvent):unknown {
  if(event.kind==='message' && event.data?.role==='user') return event.data.content ?? null;
  return null;
}

/** The provider receives the surrounding words and typed contact markers. */
export function redactPrivacyText(value:string,field?:string) {
  if(field && secretName.test(field) && literal(value))return SECRET_MASK;
  return maskPatterns(value)
    .replace(/\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-API-Key)\s*:\s*[^\r\n]+/gi,'[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi,'[URL]')
    .replace(/\b[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g,'[EMAIL ADDRESS]')
    .replace(/(?<![\w.])(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?!\w)/g,'[PHONE NUMBER]')
    .replace(/\b[A-Za-z0-9_+/=-]{20,}\b/g,token=>[/[a-z]/,/[A-Z]/,/[0-9]/,/[_+/=-]/].filter(pattern=>pattern.test(token)).length>=3||/^[a-f0-9]{24,}$/i.test(token)?'[REDACTED]':token);
}

export interface PrivacyReviewer {
  preferences:PrivacyPreferences;
  version:string;
  score:(body:unknown,rules:string)=>Promise<number>;
}
export async function reviewSessionPrompts(reviewer:PrivacyReviewer,owner:Principal,batch:import('./types.mjs').SessionBatch,key:string,store:ObjectStore) {
  if(!await reviewer.preferences.eligible(owner))return false;
  const preference=await reviewer.preferences.read(owner);
  if(!preference.enabled)return false;
  const directory=key.slice(0,key.lastIndexOf('/'))+'/privacy/';
  for(const event of batch.events){
    const body=privacyPrompt(event);
    if(body==null)continue;
    const receipt=directory+digest(JSON.stringify([reviewer.version,preference.revision,event.id]))+'.json';
    const stored=await store.get(receipt,{maxBytes:128});
    let score:number;
    if(stored)score=JSON.parse(stored.toString()).score;
    else{
      score=await reviewer.score(body,preference.rules);
      if(!Number.isFinite(score)||score<0||score>1)throw Error('Invalid session privacy score');
      const bytes=Buffer.from(JSON.stringify({score}));
      if(!await store.compareAndSet(receipt,null,bytes)){
        const winner=await store.get(receipt,{maxBytes:128});
        if(!winner)throw Error('Missing session privacy receipt');
        score=JSON.parse(winner.toString()).score;
      }
    }
    if(!Number.isFinite(score)||score<0||score>1)throw Error('Invalid session privacy receipt');
    if(score>=0.8)return true;
  }
  return false;
}
