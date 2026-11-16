import {Database} from 'bun:sqlite';
import {readdirSync} from 'node:fs';
import {join} from 'node:path';

type NativeSession={id:string,path:string,title?:{title:string,timestamp:string},parentId?:string};
/** Codex hooks can omit a transcript path. Resolve only their known session ID
 * through the native primary-key index; never enumerate transcript history or
 * load the global title index. Unknown schemas fail closed to the native hook. */
export function codexNativeSession(root:string,id:string):NativeSession|null {
  if(!/^[\w.:-]{1,200}$/.test(id))return null;
  let db:Database|undefined;
  try{
    const file=readdirSync(root).filter(name=>/^state_\d+\.sqlite$/.test(name)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];
    if(!file)return null;
    db=new Database(join(root,file),{readonly:true});
    const row=db.query('SELECT id, rollout_path, title, name, updated_at, source FROM threads WHERE id = ?').get(id) as {id:string,rollout_path:string,title?:string,name?:string,updated_at:number,source:string}|null;
    if(!row||typeof row.rollout_path!=='string')return null;
    let source:any;try{source=JSON.parse(row.source);}catch{}
    const parent=source?.subagent?.thread_spawn?.parent_thread_id;
    const title=row.name?.trim()||row.title?.trim(),time=Number(row.updated_at)*1000;
    return {id:row.id,path:row.rollout_path,...(typeof parent==='string'?{parentId:parent}:{}),...(title&&Number.isFinite(time)?{title:{title,timestamp:new Date(time).toISOString()}}:{})};
  }catch{return null;}finally{db?.close();}
}
