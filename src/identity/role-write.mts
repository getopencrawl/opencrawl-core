import {randomUUID} from 'node:crypto';
import type {ConditionalStore} from '../sessions/types.mjs';

export type RoleWriteStore = ConditionalStore;
export type TeamRole = 'admin' | 'member';
const fail = (status: number, message: string): never => {throw Object.assign(new Error(message), {status, expose:true});};
const unavailable = () => fail(503, 'Team changes need a workspace operator check before continuing.');
const encode = (value: object) => Buffer.from(JSON.stringify(value));
function record(data: Buffer | null): Record<string, unknown> | null {
  if (!data) return null;
  try {
    const value: unknown = JSON.parse(data.toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* A damaged guard must never be treated as an unlocked organization. */ }
  return unavailable();
}

function guardKey(prefix:string,organizationId:string) {
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) fail(400,'Choose a valid workspace.');
  return `${prefix}/organization-role-writes/${organizationId}.json`;
}

export async function ownsRoleWrite(store:RoleWriteStore,prefix:string,organizationId:string,operationId:string) {
  const current=record((await store.readVersion(guardKey(prefix,organizationId),{maxBytes:4096})).data);
  return current?.schemaVersion===1 && current.state==='held' && current.organizationId===organizationId && current.operationId===operationId;
}

export async function releaseRoleWrite(store:RoleWriteStore,prefix:string,organizationId:string,operationId:string,alreadyReleased=false) {
  const key=guardKey(prefix,organizationId);
  const current=await store.readVersion(key,{maxBytes:4096});
  const owner=record(current.data);
  if (owner?.schemaVersion!==1) return unavailable();
  if (owner.state!=='held' || owner.operationId!==operationId) {
    if (alreadyReleased && (owner.state==='idle' || owner.state==='held' && owner.operationId!==operationId)) return;
    return unavailable();
  }
  if (!await store.compareAndSet(key,current.version,encode({schemaVersion:1,state:'idle',operationId,completedAt:new Date().toISOString()}))) return unavailable();
}

/** A previous provider write can outlive its caller. The guard never expires. */
export function roleWriteGuard(store:RoleWriteStore,prefix:string) {
  return async (organizationId:string,actorId:string,userId:string,role:TeamRole|'remove',operationId:string=randomUUID())=>{
    const key=guardKey(prefix,organizationId);
    const previous=await store.readVersion(key,{maxBytes:4096});
    const saved=record(previous.data);
    const resuming=saved?.schemaVersion===1 && saved.state==='held' && saved.operationId===operationId &&
      saved.organizationId===organizationId && saved.actorId===actorId && saved.userId===userId && saved.role===role;
    if (!resuming) {
      if (saved && (saved.schemaVersion!==1 || saved.state!=='idle'))
        fail(409,'Another team change is in progress or awaiting verification. If this continues, contact your workspace operator.');
      const held={schemaVersion:1,state:'held',operationId,organizationId,actorId,userId,role,startedAt:new Date().toISOString()};
      if (!await store.compareAndSet(key,previous.version,encode(held)))
        fail(409,'Another team change is in progress. Please try again after it finishes.');
    }
    return {release:()=>releaseRoleWrite(store,prefix,organizationId,operationId)};
  };
}

export type RoleWriteGuard = ReturnType<typeof roleWriteGuard>;
