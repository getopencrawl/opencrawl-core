import {readFileSync,statSync} from 'node:fs';
import {atomicJson} from '../session.ts';
import {hash} from './parse.ts';

export type AttachmentScope={api:string;tenantId:string;userId:string;harness:string;installationId:string;sessionId:string};
const LIMIT=1024;
const keyFor=(scope:AttachmentScope,sha256:string)=>hash(JSON.stringify([scope.api,scope.tenantId,scope.userId,scope.harness,scope.installationId,scope.sessionId,sha256]));

/** A bounded optimization, never the source of capture durability. The caller
 * holds the installation's flush lock; in-flight entries coalesce parallel
 * batches in that flush. Eviction merely causes a later blob upload. */
export function attachmentReceipts(path:string) {
  let keys:string[]=[];
  try {
    if(statSync(path).size<=100_000){
      const saved=JSON.parse(readFileSync(path,'utf8'));
      if(saved?.version===1&&Array.isArray(saved.keys)&&saved.keys.length<=LIMIT&&saved.keys.every((key:unknown)=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)))keys=saved.keys;
    }
  } catch(error:any){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  const acknowledged=new Set(keys),pending=new Map<string,Promise<void>>();
  const save=()=>atomicJson(path,{version:1,keys:[...acknowledged]});
  return {
    async ensure(scope:AttachmentScope,sha256:string,upload:()=>Promise<boolean>) {
      const key=keyFor(scope,sha256);
      if(acknowledged.has(key))return;
      const running=pending.get(key);if(running)return running;
      const operation=(async()=>{
        // A session-deleted receipt confirms disposal, not blob storage.
        if(!await upload())return;
        acknowledged.add(key);
        while(acknowledged.size>LIMIT)acknowledged.delete(acknowledged.values().next().value!);
        save();
      })();
      pending.set(key,operation);
      try{await operation;}finally{pending.delete(key);}
    },
    forget(scope:AttachmentScope,hashes:Iterable<string>) {
      let changed=false;
      for(const sha256 of hashes)changed=acknowledged.delete(keyFor(scope,sha256))||changed;
      if(changed)save();
    },
  };
}
