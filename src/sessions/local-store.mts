import type {ObjectStore, ReadOptions, ListOptions} from './types.mjs';
import {serviceError} from './types.mjs';
import {mkdir, readFile, writeFile, rename, readdir, rmdir, unlink} from 'node:fs/promises';
import {resolve, dirname, sep} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
/** Internal filesystem test adapter. Deployed receivers use the S3 adapter. */
export function createLocalSessionStore(directory: string): ObjectStore {
  const root = resolve(directory);
  const file = (key: string) => {const path=resolve(root,key);if(!path.startsWith(root+sep))throw new Error('Invalid key');return path;};
  const store: ObjectStore={
    async put(key, data) {const path=file(key);await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.tmp-'+randomUUID();try{await writeFile(temp,data,{mode:0o600});await rename(temp,path);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}},
    async get(key,{maxBytes=Infinity}={}) {try{const data=await readFile(file(key));if(data.length>maxBytes)throw new Error('Object exceeds read limit');return data;}catch(caught){const e=serviceError(caught);if(e.code==='ENOENT')return null;throw e;}},
    async readVersion(key,options) {const data=await store.get(key,options);return {data,version:data?createHash('sha256').update(data).digest('hex'):null};},
    async compareAndSet(key,version,data) {
      const lock=file(key)+'.lock';await mkdir(dirname(lock),{recursive:true,mode:0o700});
      // Exclusive directory creation serializes independent instances/processes.
      // An abandoned test lock fails closed; never steal a possibly live lock.
      for(let attempt=0;;attempt++)try{await mkdir(lock,{mode:0o700});break;}catch(caught){const e=serviceError(caught);if(e.code!=='EEXIST'||attempt===100)throw e;await new Promise(r=>setTimeout(r,10));}
      try{if((await store.readVersion(key)).version!==version)return false;await store.put(key,data);return true;}finally{await rmdir(lock);}
    },
    async listPage(prefix,{continuationToken,maxKeys=1000}={}) {
      const keys: string[]=[];
      async function walk(directory: string,keyPrefix=''): Promise<void> {
        let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch(caught){const e=serviceError(caught);if(e.code==='ENOENT')return;throw e;}
        for(const entry of entries){if(entry.name.endsWith('.lock')||entry.name.includes('.tmp-'))continue;const key=keyPrefix+entry.name;if(entry.isDirectory())await walk(resolve(directory,entry.name),key+'/');else if(entry.isFile()&&key.startsWith(prefix)&&(!continuationToken||key>continuationToken))keys.push(key);}
      }
      await walk(root);keys.sort();return {keys:keys.slice(0,maxKeys),nextToken:keys.length>maxKeys?keys[maxKeys-1]:null};
    },
  };return store;
}
