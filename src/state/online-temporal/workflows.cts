const {proxyActivities,continueAsNew,sleep,ApplicationFailure,defineQuery,setHandler}=require('@temporalio/workflow') as typeof import('@temporalio/workflow');
import type {OnlineMigrationActivities} from './activities.mjs';
import type {OnlineMigrationReference} from './types.mjs';
const activities=proxyActivities<OnlineMigrationActivities>({startToCloseTimeout:'3 minutes',scheduleToCloseTimeout:'20 minutes',heartbeatTimeout:'30 seconds',retry:{initialInterval:'1 second',maximumInterval:'30 seconds',maximumAttempts:5}});
/** New migration-only type. No signals can inject cursors, source bodies or authority. */
async function migrateApplicationShadowV1(reference:OnlineMigrationReference):Promise<never>{
 let latest:Awaited<ReturnType<OnlineMigrationActivities['advanceOnlineMigrationV1']>>|null=null;
 setHandler(defineQuery('onlineMigrationStatus'),()=>({...reference,progress:latest,cutoverAuthorized:false}));
 if(!reference||Object.keys(reference).sort().join(',')!=='bindingId,shard'||!/^[a-f0-9]{64}$/.test(reference.bindingId)||!Number.isSafeInteger(reference.shard)||reference.shard<0||reference.shard>255)throw ApplicationFailure.nonRetryable('Invalid online migration reference','OnlineMigrationUnsafe');
 for(let pages=0;pages<32;pages++){
  const result=await activities.advanceOnlineMigrationV1(reference);
  if(!result||!['backfill','replay','parity','caught-up','waiting'].includes(result.phase)||!Number.isSafeInteger(result.revision)||result.revision<0||typeof result.waiting!=='boolean'||typeof result.parityObserved!=='boolean'||result.parityObserved&&(result.phase!=='caught-up'||result.waiting))throw ApplicationFailure.nonRetryable('Invalid online migration progress','OnlineMigrationUnsafe');
  latest=result;
  if(result.waiting||result.parityObserved)await sleep('10 seconds');
 }
 return continueAsNew<typeof migrateApplicationShadowV1>(reference);
}
exports.migrateApplicationShadowV1=migrateApplicationShadowV1;
