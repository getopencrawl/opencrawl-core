import {createHash} from 'node:crypto';

/** A trusted runtime reader supplies these hashes from the final online handoff.
 * Validating this shape does not verify parity, fence writers or grant admission.
 * Never populate it from a workflow argument or background parity observation. */
export interface OnlineIndexingHandoff {
  namespace:string;epoch:string;targetId:string;sourceSetHash:string;
  closedFrontiersHash:string;retirementHash:string;authorityReceiptHash:string;
}
export interface OnlineIndexingHandoffReader {read():Promise<OnlineIndexingHandoff>}
const keys=['namespace','epoch','targetId','sourceSetHash','closedFrontiersHash','retirementHash','authorityReceiptHash'] as const;
export function validateOnlineIndexingHandoff(input:OnlineIndexingHandoff,namespace?:string):Readonly<OnlineIndexingHandoff> {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('Invalid online indexing handoff binding'),{permanent:true});
  input={...input};
  if(Object.keys(input).sort().join(',')!==[...keys].sort().join(',')||
    typeof input.namespace!=='string'||!input.namespace||Buffer.byteLength(input.namespace)>2048||/[\u0000-\u001f\u007f]/.test(input.namespace)||
    namespace!==undefined&&input.namespace!==namespace||typeof input.epoch!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.epoch)||
    keys.slice(2).some(key=>typeof input[key]!=='string'||!/^[a-f0-9]{64}$/.test(input[key])))
    throw Object.assign(new Error('Invalid online indexing handoff binding'),{permanent:true});
  return Object.freeze(Object.fromEntries(keys.map(key=>[key,input[key]])) as unknown as OnlineIndexingHandoff);
}
export function onlineIndexingHandoffHash(input:OnlineIndexingHandoff) {
  return createHash('sha256').update(JSON.stringify(validateOnlineIndexingHandoff(input))).digest('hex');
}
