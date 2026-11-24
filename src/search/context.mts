import {z} from 'zod';
import type {SessionKey} from '../sessions/session-reference.mjs';
import {SESSION_HARNESS_PATTERN} from '../sessions/types.mjs';
import type {Principal} from '../sessions/types.mjs';
import type {SearchInput} from './types.mjs';
import {realmField} from './realm-format.mjs';
import {TOOL_OUTPUT_KINDS} from '../sessions/tool-output.mjs';

export const currentSessionSchema=z.strictObject({
  harness:z.string().regex(SESSION_HARNESS_PATTERN),
  sessionId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
}).describe('Current native chat identity, supplied by the client. Exclusion is limited to your authenticated account and this harness/session pair.');

/** Agent-search preferences add constraints; they never establish authority.
 * Omitted lower-level preferences preserve library/usage/fetch behavior. */
export function sessionSearchExclusions(principal:Principal,{currentSession,currentCapture,includeCurrentSession,includeToolOutputs}:Pick<SearchInput,'currentCapture'|'currentSession'|'includeCurrentSession'|'includeToolOutputs'>) {
  if([includeCurrentSession,includeToolOutputs].some(value=>value!==undefined&&typeof value!=='boolean'))throw Object.assign(new Error('Invalid search inclusion option'),{status:400});
  const context=currentSession===undefined?undefined:currentSessionSchema.parse(currentSession),f=(key:string)=>realmField('session',key),exclusions:unknown[]=[];
  if(context&&includeCurrentSession!==true){
    const keys:SessionKey[]=[{userId:principal.userId,...context}];
    if(currentCapture)keys.push(currentCapture);
    for(const key of keys){
      exclusions.push({bool:{filter:[{term:{[f('userId')]:key.userId}},{term:{[f('harness')]:key.harness}},{term:{[f('sessionId')]:key.sessionId}}]}});
    }
  }
  if(includeToolOutputs===false)exclusions.push({term:{[f('containsToolOutput')]:true}},
    // Existing canonical output records remain covered before metadata backfill.
    {terms:{[f('kind')]:[...TOOL_OUTPUT_KINDS]}},{terms:{[f('role')]:['tool','function']}});
  return exclusions.length?[{bool:{must_not:exclusions}}]:[];
}
