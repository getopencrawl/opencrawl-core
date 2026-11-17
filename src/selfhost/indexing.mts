import type {EventIdentityStore} from '../sessions/types.mjs';
import type {SelfhostSettings} from './settings.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {SessionDeletionResolver} from '../sessions/temporal/worker.mjs';
import type {SessionResolver} from '../sessions/temporal/worker.mjs';
import {createSessionSearch} from '../sessions/search.mjs';
import {sessionIndexingGeneration} from '../sessions/temporal/client.mjs';
/** One organization with many users. Core verifies stored owner hashes against object keys. */
export function singleOrganizationSessionSource(settings:SelfhostSettings,store:ReturnType<typeof createObjectStore>,prefix:string,eventIdentities?:EventIdentityStore){
  const sourceId='sessions-'+settings.organizationId+'-v1',search=createSessionSearch({...settings.search,store,prefix}),jobId='single-organization-sessions-v1';
  const resolve:SessionResolver=async input=>{
    if(input.sourceId!==sourceId)throw Object.assign(new Error('Session source denied'),{permanent:true});
    return {store,search,eventIdentities,prefix,jobId,resolvePrincipal:async({batch})=>{
      const {tenantId,userId}=batch.owner||{};
      if(tenantId!==settings.organizationId||!(/^(?:user_[A-Za-z0-9]+|workload_replicas_[a-f0-9]{64})$/.test(userId||'')))throw Object.assign(new Error('Stored organization scope denied'),{permanent:true});
      return {tenantId,userId};
    }};
  };
  const resolveDeletion:SessionDeletionResolver=async input=>{
    if(input.sourceId!==sourceId)throw Object.assign(new Error('Session deletion source denied'),{permanent:true});
    return {store,eventIdentities,prefix,...settings.search,tenantId:settings.organizationId};
  };
  return {sourceId,generation:sessionIndexingGeneration(search.identity,jobId),resolve,resolveDeletion};
}
