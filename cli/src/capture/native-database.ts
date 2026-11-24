import {Database} from 'bun:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CliError} from '../oauth.ts';
const invalid=()=>new CliError('CAPTURE_NATIVE_DATABASE_CHANGED','Native database changed or redirected during a read. Retry from the retained checkpoint.');

export function regular(root:string,path:string){
  const stat=lstatSync(path);
  if(!stat.isFile()||realpathSync(path)!==resolve(realpathSync(root),relative(resolve(root),resolve(path))))throw invalid();
  return stat;
}

export function readNativeDatabase<T>(root:string,path:string,read:(db:Database)=>T):T {
  const before=regular(root,path);
  for(const suffix of ['-shm','-wal','-journal'])if(lstatSync(path+suffix,{throwIfNoEntry:false}))regular(root,path+suffix);
  const hasWal=()=>Boolean(lstatSync(path+'-wal',{throwIfNoEntry:false})?.size);
  const immutable=!hasWal();
  // A closed WAL-mode database has no sidecars. Verify this read-only
  // snapshot stayed unchanged before committing its capture checkpoint.
  const db=new Database(immutable?pathToFileURL(path).href+'?immutable=1':path,{readonly:true});
  try {
    const result=db.transaction(()=>read(db))();
    if(immutable){
      const after=regular(root,path);
      if(hasWal()||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw invalid();
    }
    return result;
  } finally {db.close();}
}
