import type {DocumentItem,SearchCollection} from './types.mjs';
import {writeScript} from './mutations.mjs';
export const MAX_BULK_BYTES=4*1024*1024;
const scriptPrefix=(source:string)=>'{"scripted_upsert":true,"script":{"lang":"painless","source":'+JSON.stringify(source)+',"params":{"doc":';
// These four immutable policies recur for every indexed document. Reuse only
// their static JSON framing; never retain documents or arbitrary legacy scripts.
const scriptPrefixes=new Map((['session','connector','memory-head','session-projection'] as const).map(policy=>{const script=writeScript(policy);return [script,scriptPrefix(script)];}));
/** Shared exact framing for sizing and sending; include policy/script overhead. */
export function bulkItemLine({id,document,script:legacyScript,policy}:DocumentItem,collection:Pick<SearchCollection,'encode'|'id'>){
  const script=policy?writeScript(policy):legacyScript,doc=collection.encode(id,document);
  return JSON.stringify({[script?'update':'index']:{_id:collection.id(id),...(script?{retry_on_conflict:5}:{})}})+'\n'+(script?(scriptPrefixes.get(script)??scriptPrefix(script))+JSON.stringify(doc)+'}},"upsert":{}}':JSON.stringify(doc))+'\n';
}
