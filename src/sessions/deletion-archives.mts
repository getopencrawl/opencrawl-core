import type {ObjectStore, Principal} from './types.mjs';
import {parseJson} from './types.mjs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {digest,sessionScope} from './event-identity.mjs';

/** Scrub core migration backup formats in operator-specified archive roots.
 * Every affected version is replaced by a content-addressed sanitized copy
 * before erasure. Other sessions' backup records are preserved, not discarded.
 * Migration writers must be drained before enabling session deletion. */
export async function purgeSessionArchives({store,roots,principal,harness,sessionId}: {
  store:ObjectStore;roots:string[];principal:Principal;harness:string;sessionId:string;
}) {
  sessionScope(principal);
  if(principal.captureAccess!==undefined||!store.purgePrefix)throw new Error('Archive erasure requires a trusted reader and permanent storage deletion');
  function redact(bytes:Buffer) {
    const value=parseJson<Record<string,unknown>>(gunzipSync(bytes,{maxOutputLength:256*1024*1024}));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid session archive');
    let changed=false,found=false;
    for(const field of ['removed','previous'])if(field in value){
      found=true;const rows=value[field];if(!Array.isArray(rows))throw new Error('Invalid session archive records');
      value[field]=rows.filter((item:unknown)=>{
        if(!item||typeof item!=='object'||!('document'in item)||!item.document||typeof item.document!=='object')throw new Error('Invalid session archive document');
        const doc=item.document as Record<string,unknown>;
        if(typeof doc.tenantId!=='string'||typeof doc.userId!=='string'||typeof doc.harness!=='string'||typeof doc.sessionId!=='string')throw new Error('Invalid session archive identity');
        const remove=doc.tenantId===principal.tenantId&&doc.userId===principal.userId&&doc.harness===harness&&doc.sessionId===sessionId;
        changed ||= remove;return !remove;
      });
    }
    if(!found)throw new Error('Unknown session archive format');
    return changed?gzipSync(JSON.stringify(value)):null;
  }
  let removed=0;
  for(const root of roots){
    if(!root.endsWith('/')||root.split('/').slice(0,-1).some(part=>!part||part==='.'||part==='..'))throw new Error('Explicit session archive prefix required');
    removed+=await store.purgePrefix(root,{select:key=>key.endsWith('.json.gz'),
      selectVersion:async(_key,read)=>redact(await read())!==null,
      beforeDelete:async(key,read)=>{
        const original=await read(),sanitized=redact(original);
        if(!sanitized)throw new Error('Archive changed during erasure');
        const replacement=root+'redacted/'+digest(key)+'/'+digest(sanitized)+'.json.gz';
        await store.put(replacement,sanitized,'application/gzip');
        if(!Buffer.from(await store.get(replacement,{maxBytes:256*1024*1024})??[]).equals(sanitized))throw new Error('Sanitized archive did not persist');
      },
    });
  }
  return removed;
}
