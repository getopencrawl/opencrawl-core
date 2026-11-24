import {closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, watch, type Dirent, type FSWatcher} from 'node:fs';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {setImmediate as yieldToOwner} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {antigravityBrainDirs, harnessRoot, recordError, type CaptureConfig} from './runtime.ts';
import {daemonPathAllowed, type DaemonRegistration} from './daemon-handoff.ts';
import {atomicJson} from '../session.ts';
import {hash} from './parse.ts';
import {cursorEditorSessions,cursorStoreWorkspace} from './cursor-store.ts';
import {readNativeDatabase,regular} from './native-database.ts';

export const nativeHarnesses = ['codex', 'claude-code', 'antigravity', 'cursor'] as const;
export type NativeHarness = typeof nativeHarnesses[number];
const validId = /^[\w.:-]{1,200}$/;

// Inspect only native transcript layouts. Each intermediate directory must be
// an ordinary directory under the enrolled root, including on recovery scans.
function entries(dir: string): Dirent[] {
  try {
    if (!lstatSync(dir).isDirectory()) return [];
    return readdirSync(dir, {withFileTypes:true});
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

export function nativeRoots(config: CaptureConfig, harness: NativeHarness) {
  const root = harnessRoot(config, harness);
  if (harness === 'antigravity') return antigravityBrainDirs(root).map(surface => surface.dir);
  if (harness === 'cursor') return [join(root,'projects'),join(root,'chats'),...(config.cursorEditorRoot?[config.cursorEditorRoot]:[])];
  return [join(root, harness === 'codex' ? 'sessions' : 'projects')];
}

// Native session names are sufficient for discovery. Opening the transcript
// and validating its identity remain the responsibility of the scoped reader.
export function sessionAtPath(harness: NativeHarness, base: string, file: string) {
  const parts = relative(base, file).split(sep);
  if (parts.some(part => !part || part === '..' || part === '.')) return;
  const name = basename(file);
  let id: string | undefined;
  if (harness === 'codex' && parts.length === 4 && /^\d{4}$/.test(parts[0]!) && /^\d{2}$/.test(parts[1]!) && /^\d{2}$/.test(parts[2]!)) {
    id = /^rollout-.*-([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i.exec(name)?.[1];
  } else if (harness === 'claude-code' && parts.length === 2 && name.endsWith('.jsonl')) {
    id = name.slice(0, -6);
  } else if (harness === 'cursor' && basename(base)==='chats' && parts.length===3 && ['store.db','store.db-wal','meta.json'].includes(name)) {
    id = parts[1];
  } else if (harness === 'cursor' && parts.length === 4 && parts[1] === 'agent-transcripts' && name === parts[2]+'.jsonl') {
    id = parts[2];
  } else if (harness === 'antigravity' && parts.length === 4 && parts[1] === '.system_generated' && parts[2] === 'logs' && ['transcript.jsonl','transcript_full.jsonl'].includes(name)) {
    id = parts[0];
  }
  return id && validId.test(id) ? id : undefined;
}

function* candidates(harness: NativeHarness, base: string): Generator<string> {
  for (const first of entries(base)) {
    if (!first.isDirectory()) continue;
    const dir = join(base, first.name);
    if (harness === 'claude-code') {
      for (const file of entries(dir)) if (file.isFile() && file.name.endsWith('.jsonl')) yield join(dir,file.name);
    } else if (harness === 'cursor' && basename(base)==='chats') {
      for (const chat of entries(dir)) if (chat.isDirectory() && validId.test(chat.name)) {
        yield join(dir,chat.name,'store.db');
        yield join(dir,chat.name,'store.db-wal');
      }
    } else if (harness === 'cursor') {
      const transcripts = join(dir,'agent-transcripts');
      for (const chat of entries(transcripts)) if (chat.isDirectory() && validId.test(chat.name)) yield join(transcripts,chat.name,chat.name+'.jsonl');
    } else if (harness === 'antigravity') {
      const logs = join(dir,'.system_generated','logs');
      // Prefer the full transcript, matching the existing tailer's promotion logic.
      yield join(logs,'transcript_full.jsonl');
      yield join(logs,'transcript.jsonl');
    } else if (/^\d{4}$/.test(first.name)) {
      for (const month of entries(dir)) if (month.isDirectory() && /^\d{2}$/.test(month.name)) {
        const monthDir = join(dir,month.name);
        for (const day of entries(monthDir)) if (day.isDirectory() && /^\d{2}$/.test(day.name)) {
          const dayDir = join(monthDir,day.name);
          for (const file of entries(dayDir)) if (file.isFile() && file.name.endsWith('.jsonl')) yield join(dayDir,file.name);
        }
      }
    }
  }
}

export function discoveredSession(config: CaptureConfig, harness: NativeHarness, base: string, file: string, since: number): DaemonRegistration | undefined {
  const sessionId = sessionAtPath(harness, base, file);
  const store=harness==='cursor'&&basename(base)==='chats';
  const source=store?join(dirname(file),'store.db'):file;
  if (!sessionId || !daemonPathAllowed(config,harness,sessionId,source)) return;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size === 0 || st.mtimeMs < since) return;
    const root = resolve(harnessRoot(config,harness));
    if (realpathSync(file) !== resolve(realpathSync(root),relative(root,file))) return;
    if (harness === 'antigravity' && basename(file) === 'transcript.jsonl' && lstatSync(join(dirname(file),'transcript_full.jsonl'),{throwIfNoEntry:false})?.isFile()) return;
    let cwd:string|undefined;
    if(store)cwd=cursorStoreWorkspace(root,sessionId,source);
    return {harness, sessionId, path:source, cwd, at:Math.floor(st.mtimeMs), api:config.api,
      installationId:config.installationId, owner:{tenantId:config.owner.tenantId,userId:config.owner.userId}};
  } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
}

export async function scanNativeRoot(config: CaptureConfig, harness: NativeHarness, base: string, since: number, visit: (registration: DaemonRegistration) => void, stopped: () => boolean, report:(error:unknown)=>void) {
  let complete=true;
  const accept=(registration:DaemonRegistration)=>{
    try{visit(registration);}catch(error){report(error);complete=false;}
  };
  if(harness==='cursor'&&base===config.cursorEditorRoot){
    for(const row of cursorEditorSessions(base,since)){
      if(stopped())return false;
      accept({harness,sessionId:row.id,path:join(base,'state.vscdb'),at:row.updated_at,api:config.api,installationId:config.installationId,owner:config.owner});
    }
    return complete;
  }
  let count = 0;
  for (const file of candidates(harness,base)) {
    if (++count % 64 === 0) await yieldToOwner();
    if (stopped()) return false;
    try{
      const registration = discoveredSession(config,harness,base,file,since);
      if (registration) accept(registration);
    }catch(error){report(error);complete=false;}
  }
  return complete;
}

// Never infer a project path from a lossy project-directory slug. A client
// without authoritative cwd metadata continues to fail closed on exclusions.
export function transcriptWorkspace(registration: DaemonRegistration,config: CaptureConfig) {
  if(registration.harness==='antigravity'){
    const surface=antigravityBrainDirs(harnessRoot(config,'antigravity')).find(({dir})=>registration.path.startsWith(dir+sep));
    if(!surface)return;
    const root=dirname(surface.dir),db=join(root,'conversation_summaries.db');
    if(!existsSync(db))return;
    const row=readNativeDatabase(root,db,db=>db.query('SELECT workspace_uris,parent_conversation_id FROM conversation_summaries WHERE conversation_id=?').get(registration.sessionId)) as {workspace_uris:string,parent_conversation_id:string}|null;
    if(!row)return;
    if(typeof row.parent_conversation_id==='string'&&validId.test(row.parent_conversation_id))registration.parentSessionId=row.parent_conversation_id;
    const uris=JSON.parse(row.workspace_uris||'[]');
    if(Array.isArray(uris)&&uris.length===1&&typeof uris[0]==='string'&&uris[0].startsWith('file:'))return fileURLToPath(uris[0]);
    return;
  }
  if(registration.harness==='cursor'&&config.cursorEditorRoot&&basename(registration.path)==='state.vscdb'){
    const storage=join(dirname(config.cursorEditorRoot),'workspaceStorage'),folders=new Set<string>();
    for(const entry of entries(storage)){
      if(!entry.isDirectory())continue;
      const folder=join(storage,entry.name),db=join(folder,'state.vscdb'),meta=join(folder,'workspace.json');
      if(!existsSync(db)||!existsSync(meta)||regular(storage,meta).size>64*1024)continue;
      const match=readNativeDatabase(storage,db,db=>db.query("SELECT 1 FROM ItemTable, json_tree(ItemTable.value) AS item WHERE ItemTable.key='composer.composerData' AND item.atom=? LIMIT 1").get(registration.sessionId));
      if(!match)continue;
      const uri=JSON.parse(readFileSync(meta,'utf8')).folder;
      if(typeof uri!=='string'||!uri.startsWith('file:'))return;
      folders.add(fileURLToPath(uri));
    }
    if(folders.size===1)return [...folders][0];
    return;
  }
  if (!['claude-code','codex'].includes(registration.harness)) return;
  const fd = openSync(registration.path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd,buf,0,buf.length,0);
    for (const line of buf.subarray(0,bytes).toString('utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const cwd = registration.harness === 'codex'
        ? row.type === 'session_meta' && row.payload?.id === registration.sessionId && row.payload.cwd
        : row.sessionId === registration.sessionId && row.cwd;
      if(registration.harness==='codex'&&row.type==='session_meta'&&row.payload?.id===registration.sessionId){
        const parent=row.payload.forked_from_id??row.payload.source?.subagent?.thread_spawn?.parent_thread_id;
        if(typeof parent==='string'&&validId.test(parent))registration.parentSessionId=parent;
      }
      if (typeof cwd === 'string') return cwd;
    }
  } finally { closeSync(fd); }
}

/** Watch ordinary writes for low latency. A metadata sweep also finds writes
 * made during downtime or on filesystems without recursive notifications.
 * Commit the scan's START time after every registration is durable, so writes
 * racing enumeration and crashes cannot fall between two recovery intervals. */
export function nativeDiscovery(dir: string, current: () => CaptureConfig | null, visit: (registration: DaemonRegistration) => void, stopped: () => boolean) {
  const watchers = new Map<string,FSWatcher>();
  const firstStart = Date.now();
  const reported = new Set<string>();
  const report = (error:unknown) => {
    const msg = String(error);
    if (!reported.has(msg)) { reported.add(msg); recordError(error); }
  };
  async function recover() {
    const config = current();
    const enabled = new Set<string>();
    if (config && !config.disabled && !config.authPending) for (const harness of nativeHarnesses) {
      if (!config.harnesses?.includes(harness)) continue;
      for (const base of nativeRoots(config,harness)) {
        if (stopped()) return;
        const selectedAt = config.discoverySince?.[harness];
        const identity = JSON.stringify([config.api,config.owner.tenantId,config.owner.userId,config.installationId,harness,base,selectedAt]);
        const file = join(dir,'discovery-'+hash(identity)+'.json');
        enabled.add(identity);
        try {
          const saved = existsSync(file) ? JSON.parse(readFileSync(file,'utf8')) : null;
          const floor = selectedAt ?? saved?.floor ?? firstStart;
          const since = Math.max(saved?.since ?? floor,floor);
          if (!Number.isFinite(since)||!Number.isFinite(floor)) throw Error('Invalid native discovery checkpoint');
          if(!saved)atomicJson(file,{floor,since});
          const expectedRoot=base===config.cursorEditorRoot?base:harnessRoot(config,harness);
          if(!existsSync(base)||!lstatSync(base).isDirectory()||realpathSync(base)!==resolve(realpathSync(expectedRoot),relative(resolve(expectedRoot),base)))continue;
          if(base===config.cursorEditorRoot&&!existsSync(join(base,'conversation-search.db')))continue;
          if (base!==config.cursorEditorRoot && !watchers.has(identity) && existsSync(base) && lstatSync(base).isDirectory()) {
            try {
              const watcher = watch(base,{recursive:true},(_event,name)=>{
                if (!name || stopped() || !sessionAtPath(harness,base,join(base,name.toString()))) return;
                try {
                  const latest = current();
                  if (!latest || latest.disabled || latest.authPending || !latest.harnesses?.includes(harness) || latest.discoverySince?.[harness] !== selectedAt) return;
                  const found = discoveredSession(latest,harness,base,join(base,name.toString()),floor);
                  if (found) visit({...found,discoverySince:floor});
                } catch(error) { report(error); }
              });
              watcher.on('error',()=>{watcher.close();watchers.delete(identity);});
              watchers.set(identity,watcher);
            } catch { /* The metadata sweep also works without a watcher. */ }
          }
          const started = Date.now();
          const complete=await scanNativeRoot(config,harness,base,since,r=>visit({...r,discoverySince:floor}),stopped,report);
          if (complete&&!stopped()) atomicJson(file,{floor,since:started});
        } catch(error) { report(error); }
      }
    }
    for (const [id,watcher] of watchers) if (!enabled.has(id)) {watcher.close();watchers.delete(id);}
  }
  return {recover,close(){for(const watcher of watchers.values())watcher.close();watchers.clear();}};
}
