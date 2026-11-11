import type {ObjectStore, Principal} from './types.mjs';
import {parseJson} from './types.mjs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {digest,sessionScope} from './event-identity.mjs';
import {createControls} from './controls.mjs';
import {withSessionDocumentWrites} from './write-barrier.mjs';
import type {DocumentItem} from '../search/types.mjs';

/** Scrub core migration backup formats in operator-specified archive roots.
 * Every affected version is replaced by a content-addressed sanitized copy
 * before erasure. Other sessions' backup records are preserved, not discarded.
 * Migration writers must be drained before enabling session deletion. */
export async function purgeSessionArchives({store,prefix,roots,principal,harness,sessionId}: {
  store:ObjectStore;prefix:string;roots:string[];principal:Principal;harness:string;sessionId:string;
}) {
  sessionScope(principal);
  if(principal.captureAccess!==undefined||!store.purgePrefix)throw new Error('Archive erasure requires a trusted reader and permanent storage deletion');
  const controls=createControls({store,prefix});
  async function redact(bytes:Buffer) {
    const value=parseJson<Record<string,unknown>>(gunzipSync(bytes,{maxOutputLength:256*1024*1024}));
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid session archive');
    let changed=false,found=false;const documents:DocumentItem[]=[];
    for(const field of ['removed','previous'])if(field in value){
      found=true;const rows=value[field];if(!Array.isArray(rows))throw new Error('Invalid session archive records');
      const kept:unknown[]=[];
      for(const item of rows){
        if(!item||typeof item!=='object'||!('document'in item)||!item.document||typeof item.document!=='object')throw new Error('Invalid session archive document');
        const doc=item.document as Record<string,unknown>;
        if(typeof doc.tenantId!=='string'||typeof doc.userId!=='string'||typeof doc.harness!=='string'||typeof doc.sessionId!=='string')throw new Error('Invalid session archive identity');
        if(doc.tenantId!==principal.tenantId)throw new Error('Session archive tenant mismatch');
        const remove=doc.userId===principal.userId&&doc.harness===harness&&doc.sessionId===sessionId ||
          Boolean((await controls.read({tenantId:doc.tenantId,userId:doc.userId},'sessions',doc.harness,doc.sessionId))?.deletedAt);
        changed ||= remove;if(!remove){kept.push(item);documents.push(item as DocumentItem);}
      }
      value[field]=kept;
    }
    if(!found)throw new Error('Unknown session archive format');
    return changed?{bytes:gzipSync(JSON.stringify(value)),documents}:null;
  }
  let removed=0;
  for(const root of roots){
    if(!root.endsWith('/')||root.split('/').slice(0,-1).some(part=>!part||part==='.'||part==='..'))throw new Error('Explicit session archive prefix required');
    removed+=await store.purgePrefix(root,{select:key=>key.endsWith('.json.gz'),
      selectVersion:async(_key,read)=>(await redact(await read()))!==null,
      beforeDelete:async(key,read)=>{
        const original=await read();
        for(let attempt=0;;attempt++){
          const sanitized=await redact(original);
          if(!sanitized)throw new Error('Archive changed during erasure');
          const replacement=root+'redacted/'+digest(key)+'/'+digest(sanitized.bytes)+'.json.gz';
          try{await withSessionDocumentWrites({store,prefix,tenantId:principal.tenantId,documents:sanitized.documents},()=>store.put(replacement,sanitized.bytes,'application/gzip'));}
          catch(error){if(attempt<3&&(error as {status?:number}).status===403)continue;throw error;}
          if(!Buffer.from(await store.get(replacement,{maxBytes:256*1024*1024})??[]).equals(sanitized.bytes))throw new Error('Sanitized archive did not persist');
          break;
        }
      },
    });
  }
  return removed;
}
