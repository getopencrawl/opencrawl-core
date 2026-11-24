import {createHash, randomUUID} from 'node:crypto';
import {gzip, gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {ConditionalStore} from './types.mjs';

const MiB = 1024 * 1024;
const zip = promisify(gzip), unzip = promisify(gunzip);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const streamName = /^[A-Za-z0-9_-]{1,128}$/, recordHash = /^[A-Za-z0-9_-]{12}$/;
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error('Invalid count snapshot: ' + reason);
}
export class CountSnapshotBudgetExceeded extends Error {
  constructor() {
    super('Count snapshot exceeds the isolated worker budget. Retain the published count and retry with a larger budget for this connection.');
    this.name = 'CountSnapshotBudgetExceeded';
  }
}
function budget(condition: boolean) {
  if (!condition) throw new CountSnapshotBudgetExceeded();
}
function object(value: unknown): Record<string,unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value),'object expected');
  return value as Record<string,unknown>;
}
interface FullCount {sync: number | null; count: number}
interface FullPass {sync: number; finished: boolean; scan: string; ids: Set<string>; read: Set<string>}
type SnapshotStore = Pick<ConditionalStore,'readVersion' | 'compareAndSet'>;
export interface CountSnapshotOptions {
  store: SnapshotStore; connectionId: string; rawPrefix: string;
  /** Only the worker's trusted connection binding may increase its budget. */
  maxSnapshotBytes?: number;
}
export function countCheckpointKey(connectionId: string) {
  check(/^int_[a-f0-9]{26}$/.test(connectionId),'connection ID');
  return '_opencrawl/counts/connection='+connectionId+'.json.gz';
}

async function readSnapshot({store,rawPrefix,connectionId,maxSnapshotBytes:cap=8*MiB}:
    Omit<CountSnapshotOptions,'store'> & {store:Pick<SnapshotStore,'readVersion'>}) {
  check(Number.isSafeInteger(cap) && cap >= 65536 && cap <= 64*MiB,'configured snapshot budget');
  const key = countCheckpointKey(connectionId);
  check(rawPrefix.startsWith('raw/v1/source=') && rawPrefix.endsWith('/connection='+connectionId+'/') &&
    !rawPrefix.split('/').some(p => p === '.' || p === '..'),'source prefix');
  const {data,version} = await store.readVersion(key,{maxBytes:cap}).catch(error=>{
    if(error?.code==='ObjectReadLimitExceeded')throw new CountSnapshotBudgetExceeded();
    throw error;
  });
  check(data === null ? version === null : version !== null,'object version');
  const observedPointer = data === null ? null : sha(data);
  const expanded = cap*4, maxEntries = Math.floor(cap/13);
  let entries = 0, used = 0;
  const incremental = new Map<string,Set<string>>(), full = new Map<string,FullCount>(), pending = new Map<string,FullPass>();
  function partStream(path: string) {
    check(typeof path === 'string' && Buffer.byteLength(path) <= 1024 && path.startsWith(rawPrefix) &&
      !path.split('/').some(s => s === '.' || s === '..'),'receipt scope');
    const name = /^stream=([A-Za-z0-9_-]{1,128})\//.exec(path.slice(rawPrefix.length))?.[1];
    check(name,'receipt stream');
    return name;
  }
  function fit(count: number, bytes: number) {
    budget(entries+count <= maxEntries && used+bytes <= expanded);
  }
  function strings(values: unknown, validate: (item: string) => boolean) {
    check(Array.isArray(values),'string array expected');
    fit(values.length,0);
    const found = new Set<string>();
    for (const item of values) {
      check(typeof item === 'string' && validate(item),'invalid hash or receipt');
      if (!found.has(item)) {
        const size = Buffer.byteLength(item)+3;
        fit(1,size); entries++; used+=size; found.add(item);
      }
    }
    return found;
  }
  let read = new Set<string>();
  if (data) {
    budget(data.length <= cap);
    const raw = await unzip(data,{maxOutputLength:expanded}).catch(error=>{
      if(error.code==='ERR_BUFFER_TOO_LARGE')budget(false);
      throw error;
    });
    // Bound the allocation overhead of hostile or malformed containers before parsing.
    let structural = 0;
    for (const byte of raw) if(byte===44 || byte===91 || byte===123)structural++;
    budget(structural <= maxEntries+4096);
    const saved = object(JSON.parse(raw.toString('utf8')));
    check(saved.version===1,'version');
    read = strings(saved.read,path=>Boolean(partStream(path)));
    for (const [name,values] of Object.entries(object(saved.ids))) {
      check(streamName.test(name) && incremental.size<128,'incremental stream');
      incremental.set(name,strings(values,s=>recordHash.test(s)));
    }
    for (const [name,value] of Object.entries(object(saved.full??{}))) {
      const f = object(value);
      check(streamName.test(name) && full.size<128 && (f.sync===null || safeInteger(f.sync)) && safeInteger(f.count),'full stream');
      full.set(name,{sync:f.sync,count:f.count});
    }
    for (const [name,value] of Object.entries(object(saved.pendingFull??{}))) {
      const f = object(value);
      check(streamName.test(name) && pending.size<128 && safeInteger(f.sync) && typeof f.finished==='boolean' &&
        typeof f.scan==='string' && f.scan.length>0 && f.scan.length<=200,'partial full stream');
      pending.set(name,{sync:f.sync,finished:f.finished,scan:f.scan,ids:strings(f.ids,s=>recordHash.test(s)),read:strings(f.read,k=>partStream(k)===name)});
    }
  }
  function visible(): Record<string,number> {
    return Object.fromEntries([...Array.from(incremental,([name,ids])=>[name,ids.size]),...Array.from(full,([name,f])=>[name,f.count])]);
  }
  return {key,version,observedPointer,cap,expanded,fit,read,incremental,full,pending,partStream,visible,
    reserve(count:number,bytes:number){fit(count,bytes);entries+=count;used+=bytes;}};
}

/** Read the last visible v1 measurement at the original authorized key. */
export async function readLegacyCountSnapshot(options: Omit<CountSnapshotOptions,'store'> & {store:Pick<SnapshotStore,'readVersion'>}) {
  const state = await readSnapshot(options);
  return state.observedPointer ? {pointer:state.observedPointer,counts:state.visible()} : null;
}
export async function openCountSnapshot(options: CountSnapshotOptions) {
  const s = await readSnapshot(options);
  const {incremental,full,pending,read,observedPointer} = s;
  const selected = new Set<string>();
  const originalFull = new Map(full), hadPartial = pending.size > 0;
  let dirty = false, incrementalChanged = false;
  function hasPart(name:string,sync:number|null,key:string) {
    check(s.partStream(key)===name,'part stream');
    if (sync===null) return read.has(key);
    const p=pending.get(name);
    return full.get(name)?.sync===sync || p?.sync===sync && p.read.has(key);
  }
  function discard(name:string) {
    const prior=pending.get(name);
    if(!prior)return;
    let bytes=prior.ids.size*15;
    for(const k of prior.read)bytes+=Buffer.byteLength(k)+3;
    s.reserve(-prior.ids.size-prior.read.size,-bytes);
    pending.delete(name);
  }
  function selectFull(name:string,sync:number,finished:boolean,scan:string) {
    check(streamName.test(name) && safeInteger(sync) && typeof scan==='string' && scan.length>0 && scan.length<=200,'full refresh selection');
    selected.add(name);
    const p=pending.get(name);
    if (full.get(name)?.sync===sync) {if(p){discard(name);dirty=true;}return;}
    if (p?.sync===sync && p.finished===finished && p.scan===scan) return;
    discard(name);
    check(pending.size<128,'full stream limit');
    pending.set(name,{sync,finished,scan,ids:new Set(),read:new Set()});dirty=true;
  }
  async function withPart(name:string,sync:number|null,key:string,consume:(add:(hash:string)=>void)=>Promise<unknown>) {
    if(hasPart(name,sync,key))return;
    const p=pending.get(name), prior=sync===null?incremental.get(name):p?.ids;
    check(sync===null || p?.sync===sync,'unselected full refresh');
    const added=new Set<string>(),receiptBytes=Buffer.byteLength(key)+3;
    await consume(hash=>{
      check(typeof hash==='string' && recordHash.test(hash),'record hash');
      if(!prior?.has(hash)) added.add(hash);
      s.fit(added.size+1,added.size*15+receiptBytes);
    });
    s.reserve(added.size+1,added.size*15+receiptBytes);
    if(sync===null && !prior){
      check(incremental.size<128,'incremental stream limit');
      incremental.set(name,added);
    }else for(const hash of added)prior!.add(hash);
    (sync===null?read:p!.read).add(key);
    if(sync===null)incrementalChanged=true;
    dirty=true;
  }
  function summary() {
    const counts=s.visible();
    for(const [name,p] of pending)if(selected.has(name))counts[name]=p.ids.size;
    return counts;
  }
  function finalize() {
    for(const [name,p] of pending){
      if(selected.has(name))full.set(name,{sync:p.finished?p.sync:null,count:p.ids.size});
      discard(name);
    }
    // A provisional full sync can be re-read for correctness and yield
    // precisely its old count. Transient key sets do not require a PUT.
    dirty=incrementalChanged || hadPartial || full.size!==originalFull.size ||
      [...full].some(([name,value])=>value.sync!==originalFull.get(name)?.sync || value.count!==originalFull.get(name)?.count);
  }
  async function prepareSave() {
    if(!dirty && observedPointer)return {pointer:observedPointer,write:async()=>{}};
    // Keep fields read by previous releases intact. Before a full scan finishes,
    // rollback readers see its last completed count; its partial keys stay private.
    const encoded=JSON.stringify({version:1,nonce:randomUUID(),read:[...read],
      ids:Object.fromEntries(Array.from(incremental,([name,ids])=>[name,[...ids]])),full:Object.fromEntries(full),
      ...(pending.size?{pendingFull:Object.fromEntries(Array.from(pending,([name,p])=>[name,{...p,ids:[...p.ids],read:[...p.read]}]))}:{})});
    budget(Buffer.byteLength(encoded)<=s.expanded);
    const bytes=await zip(encoded);budget(bytes.length<=s.cap);
    return {pointer:sha(bytes),async write(){
      const applied=await options.store.compareAndSet(s.key,s.version,bytes,{signal:AbortSignal.timeout(10000),contentType:'application/gzip'});
      if(!applied)throw new Error('Count checkpoint changed; retry from the current source object');
    }};
  }
  return {hasPart,selectFull,withPart,finalize,summary,prepareSave,observedPointer,get dirty(){return dirty;},
    async close(){incremental.clear();full.clear();pending.clear();read.clear();}};
}
