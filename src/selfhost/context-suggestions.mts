import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {CheckJudgment} from '../search/check.mjs';
import type {SuggestionObserver} from '../search/suggestion-events.mjs';

export interface ContextSuggestionsExtension {
  /** A new instance per request; keep provider budgets and mutable state here. */
  judgment?:()=>CheckJudgment;
  observe?:SuggestionObserver;
}
/** Explicit operator-owned code, loaded once at startup. No remote modules,
 * tenant-controlled paths, credential discovery or hosted fallback. */
export async function loadContextSuggestions(path:string|undefined):Promise<ContextSuggestionsExtension> {
  if(!path)return {};
  if(!isAbsolute(path))throw Error('OPENCRAWL_CONTEXT_SUGGESTIONS_MODULE must be an absolute local path');
  const module:unknown=await import(pathToFileURL(path).href);
  if(!module||typeof module!=='object')throw Error('Invalid context suggestions extension');
  const {judgment,observe}=module as Record<string,unknown>;
  if(judgment!==undefined&&typeof judgment!=='function'||observe!==undefined&&typeof observe!=='function'||!judgment&&!observe)throw Error('Extension must export judgment and/or observe functions');
  return {judgment:judgment as ContextSuggestionsExtension['judgment'],observe:observe as ContextSuggestionsExtension['observe']};
}
