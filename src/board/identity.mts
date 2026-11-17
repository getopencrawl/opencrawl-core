import {createHash} from 'node:crypto';

/** Stable account-bound identity, preserved exactly across the SQL migration. */
export const boardIdentity = (userId: string, handle: string) => createHash('sha256').update(JSON.stringify([userId, handle])).digest('hex');

/** Resolve an account-owned registration without changing presence or lifecycle. */
export async function resolveBoardIdentity(reader:import('../state/board.mjs').BoardReader,userId:string,name:string){
 const registered=Object.entries(await reader.profiles()).find(([,p])=>p.userId===userId&&p.name.toLowerCase()===name.toLowerCase());
 return {userId,agent:registered?.[0]??boardIdentity(userId,name),name:registered?.[1].name??name,registered:Boolean(registered)};
}
