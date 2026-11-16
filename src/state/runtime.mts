import type {ApplicationDatabase} from './postgres.mjs';
import {applicationDatabase} from './settings.mjs';
import {requireApplicationStateReady} from './postgres.mjs';
import {createApplicationState} from './application.mjs';
/** Standalone operator tools use the same migrated installation as HTTP/workers. */
export async function openApplicationState(env:NodeJS.ProcessEnv=process.env){
  const database=applicationDatabase(env);
  try {await database.ready();await requireApplicationStateReady(database);return {database,state:await createApplicationState({database}),close:()=>database.close()};}
  catch(error){await database.close();throw error;}
}

/** Standalone configuration cannot redirect one installation's checkpoints and
 * fences onto another bucket or tenant. Multi-tenant hosted bindings require
 * their own reviewed resolver; this helper deliberately has no bypass. */
export function assertApplicationSource(database:ApplicationDatabase,{bucket,tenantId}:{bucket:string;tenantId:string}):void{
 const source=database.sourceIdentity;
 if(!source||source.version!==1||!source.organizationId||source.bucket!==bucket||source.organizationId!==tenantId)throw Object.assign(new Error('Standalone source differs from the application installation binding'),{status:403,permanent:true});
}
