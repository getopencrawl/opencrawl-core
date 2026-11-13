import type {Principal, ObjectStore} from '../sessions/types.mjs';
import type {MemorySnapshot, StoredMemorySnapshot} from './types.mjs';
import {parseJson} from '../sessions/types.mjs';
import {gzipSync} from 'node:zlib';
import {digest,sessionScope} from '../sessions/event-identity.mjs';

export const MAX_MEMORY_BYTES=32*1024*1024;
const id=(v: unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(v);
function fail(status: number,message: string): never {throw Object.assign(new Error(message),{status,permanent:status===400||status===403});}
export function validateMemorySnapshot(snapshot: MemorySnapshot,principal: Principal) {
  sessionScope(principal);
  if(snapshot?.schemaVersion!==1||!id(snapshot.installationId)||!['codex','claude-code'].includes(snapshot.harness)||
    !Number.isSafeInteger(snapshot.generation)||snapshot.generation<1||!Array.isArray(snapshot.files)||snapshot.files.length>4096||
    typeof snapshot.host!=='string'||snapshot.host.length>256)fail(400,'Invalid memory snapshot');
  if(snapshot.owner?.tenantId!==principal.tenantId||snapshot.owner?.userId!==principal.userId)fail(403,'Memory owner does not match signed-in account');
  const paths=new Set();
  for(const f of snapshot.files) {
    if(!f||typeof f.path!=='string'||f.path.length>2048||!f.path.endsWith('.md')||f.path.split('/').some(p=>!p||p==='.'||p==='..')||f.path.includes('\\')||paths.has(f.path)||
      typeof f.text!=='string'||Buffer.byteLength(f.text)>2*1024*1024||typeof f.project!=='string'||f.project.length>2048||
      typeof f.modifiedAt!=='string'||!Number.isFinite(Date.parse(f.modifiedAt)))fail(400,'Invalid memory file');
    paths.add(f.path);
  }
  if(Buffer.byteLength(JSON.stringify(snapshot))>MAX_MEMORY_BYTES)fail(413,'Memory snapshot exceeds limit');
  return snapshot;
}
export const memorySnapshotId=(snapshot: MemorySnapshot)=>digest(JSON.stringify(snapshot));
export function memorySourceIdentity(prefix: string,key: string) {
  if(typeof key!=='string'||!key.startsWith(prefix+'/'))return null;
  const m=/^tenants\/([a-f0-9]{64})\/users\/([a-f0-9]{64})\/memories\/(codex|claude-code)\/([a-f0-9]{64})\/(\d+)-([a-f0-9]{64})\.json\.gz$/.exec(key.slice(prefix.length+1));
  return m?{tenantHash:m[1],userHash:m[2],harness:m[3],installationHash:m[4],generation:Number(m[5]),snapshotId:m[6]}:null;
}
export function createMemoryIngest({store,prefix,scheduleIndexing}: {store: ObjectStore; prefix: string; scheduleIndexing?: (key: string) => Promise<unknown>}) {
  return {async putSnapshot(principal: Principal,input: MemorySnapshot) {
    // Freeze the supplied JSON before validation and I/O.
    let snapshot: MemorySnapshot;try{snapshot=parseJson<MemorySnapshot>(JSON.stringify(input));}catch{fail(400,'Invalid memory JSON');}
    if(snapshot?.receivedAt!==undefined||snapshot?.snapshotId!==undefined)fail(400,'Server memory metadata cannot be supplied');
    validateMemorySnapshot(snapshot,principal);
    if(snapshot.generation>Date.now()+86400000)fail(400,'Memory generation is in the future');
    const snapshotId=memorySnapshotId(snapshot);
    const key=`${prefix}/${sessionScope(principal)}/memories/${snapshot.harness}/${digest(snapshot.installationId)}/${snapshot.generation}-${snapshotId}.json.gz`;
    const exists=store.has?await store.has(key,{maxBytes:MAX_MEMORY_BYTES+1048576}):await store.get(key,{maxBytes:MAX_MEMORY_BYTES+1048576});
    if(!exists)await store.put(key,gzipSync(JSON.stringify({...snapshot,receivedAt:new Date().toISOString(),snapshotId})),'application/gzip');
    if(scheduleIndexing)await scheduleIndexing(key);
    return {snapshotId,generation:snapshot.generation,files:snapshot.files.length,stored:true};
  }};
}
export function verifyStoredMemory({prefix,key,snapshot,principal}: {prefix: string; key: string; snapshot: StoredMemorySnapshot; principal: Principal}) {
  const identity=memorySourceIdentity(prefix,key);
  const {receivedAt,snapshotId,...original}=snapshot;
  validateMemorySnapshot(original,principal);
  if(!identity||identity.tenantHash!==digest(principal.tenantId)||identity.userHash!==digest(principal.userId)||
    identity.harness!==snapshot.harness||identity.installationHash!==digest(snapshot.installationId)||identity.generation!==snapshot.generation||
    identity.snapshotId!==snapshotId||memorySnapshotId(original)!==snapshotId||!Number.isFinite(Date.parse(receivedAt)))fail(403,'Stored memory scope or content mismatch');
  return snapshot;
}
