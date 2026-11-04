import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {resolve, dirname, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
/** Single-tenant/reference adapter; production hosted storage uses S3. */
export function createLocalSessionStore(directory) {
  const root = resolve(directory);
  const file = key => {const path=resolve(root,key);if(!path.startsWith(root+sep))throw new Error('Invalid key');return path;};
  return {
    async put(key, data) {const path=file(key);await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID();await writeFile(temp,data,{mode:0o600});await rename(temp,path);},
    async get(key) {try{return await readFile(file(key));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  };
}
