import type {DocumentItem,SearchCollection} from './types.mjs';
import {writeScript} from './mutations.mjs';
export const MAX_BULK_BYTES=4*1024*1024;
/** Shared exact framing for sizing and sending; include policy/script overhead. */
export function bulkItemLine({id,document,script:legacyScript,policy}:DocumentItem,collection:Pick<SearchCollection,'encode'|'id'>){
  const script=policy?writeScript(policy):legacyScript,doc=collection.encode(id,document);
  return JSON.stringify({[script?'update':'index']:{_id:collection.id(id),...(script?{retry_on_conflict:5}:{})}})+'\n'+JSON.stringify(script?{scripted_upsert:true,script:{lang:'painless',source:script,params:{doc}},upsert:{}}:doc)+'\n';
}
