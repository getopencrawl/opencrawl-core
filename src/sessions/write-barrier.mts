import type {ObjectStore, Principal} from './types.mjs';
import {createConnectorWriteBarrier} from '../connectors/write-barrier.mjs';
import {digest, sessionScope} from './event-identity.mjs';
import {isSessionHarness} from './types.mjs';
import type {DocumentItem} from '../search/types.mjs';
import {createControls} from './controls.mjs';

/** Reuse the durable CAS fence. Only hashes and write receipts are retained;
 * the fence is outside raw capture prefixes and never expires or reopens. */
export function sessionWriteBarrier(store: ObjectStore, prefix: string, owner: Principal, harness: string, sessionId: string) {
  sessionScope(owner);
  if (!isSessionHarness(harness) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) throw new Error('Invalid session fence identity');
  return createConnectorWriteBarrier({store, namespace: 'sessions', tenantId: digest(owner.tenantId),
    controlPrefix: `${prefix}/${sessionScope(owner)}/controls/write-barriers/`,
    connectionId: digest(JSON.stringify([prefix, owner.userId, harness, sessionId]))});
}

/** Fence individual remote writes, including CAS event ledgers. A rejected
 * read cannot strand a writer; an ambiguous remote write must remain pending. */
export function sessionWriteStore(store: ObjectStore, prefix: string, owner: Principal, harness: string, sessionId: string): ObjectStore {
  const barrier = sessionWriteBarrier(store, prefix, owner, harness, sessionId);
  return {...store,
    put: (key, bytes, type) => barrier.run('object-put', () => store.put(key, bytes, type), {target: digest(key)}),
    compareAndSet: (key, version, bytes) => barrier.run('object-put', () => store.compareAndSet(key, version, bytes), {target: digest(key)}),
  };
}

/** A migration may copy several sessions in one remote write. Acquire every
 * affected session's fence before invoking it, including backup writes. */
export async function withSessionDocumentWrites<T>({store,prefix,tenantId,documents}: {
  store:ObjectStore;prefix:string;tenantId:string;documents:DocumentItem[];
},write:()=>Promise<T>):Promise<T> {
  if(!store||!prefix)throw new Error('Session migrations require authoritative deletion controls');
  const controls=createControls({store,prefix}),identities=new Map<string,{owner:Principal;harness:string;sessionId:string}>();
  for(const {document:d} of documents){
    if(d.tenantId!==tenantId||typeof d.userId!=='string'||typeof d.harness!=='string'||typeof d.sessionId!=='string')throw new Error('Invalid migration session identity');
    const owner={tenantId,userId:d.userId};sessionScope(owner);
    identities.set(JSON.stringify([owner.userId,d.harness,d.sessionId]),{owner,harness:d.harness,sessionId:d.sessionId});
  }
  const sessions=[...identities].sort(([a],[b])=>a.localeCompare(b)).map(([,value])=>value);
  for(const {owner,harness,sessionId} of sessions)if((await controls.read(owner,'sessions',harness,sessionId))?.deletedAt)
    throw Object.assign(new Error('Deleted session cannot be copied or restored'),{status:403,writeOutcome:'not-applied'});
  let started=false;
  async function enter(index:number):Promise<T>{
    if(index===sessions.length){started=true;return write();}
    const {owner,harness,sessionId}=sessions[index]!;
    return sessionWriteBarrier(store,prefix,owner,harness,sessionId).run('search-write',async()=>{
      try{return await enter(index+1);}catch(error){
        // A deeper fence refused acquisition; no content write has begun.
        if(!started&&error instanceof Error)Object.assign(error,{writeOutcome:'not-applied'});
        throw error;
      }
    },{target:'session-migration'});
  }
  return enter(0);
}
