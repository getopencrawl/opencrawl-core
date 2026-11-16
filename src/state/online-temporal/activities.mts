import {Context,heartbeat} from '@temporalio/activity';
import {ApplicationFailure,CancelledFailure} from '@temporalio/common';
import type {OnlineMigrationController} from './controller.mjs';
import type {OnlineMigrationReference} from './types.mjs';
export function onlineMigrationActivities(controller:Pick<OnlineMigrationController,'advance'>){
 return {async advanceOnlineMigrationV1(reference:OnlineMigrationReference){
  const pulse=setInterval(()=>heartbeat(),10000);
  try{heartbeat();return await controller.advance(reference,Context.current().cancellationSignal);}
  catch(error){
   if(Context.current().cancellationSignal.aborted)throw new CancelledFailure('Online migration cancelled');
   if(error&&typeof error==='object'&&'code' in error&&error.code==='ONLINE_MIGRATION_UNSAFE')throw ApplicationFailure.nonRetryable('Online migration binding or parity verification failed','OnlineMigrationUnsafe');
   // Provider bodies, credentials, SQL and source keys never enter history.
   throw ApplicationFailure.retryable('Online migration page failed','OnlineMigrationPageFailed');
  }finally{clearInterval(pulse);}
 }};
}
export type OnlineMigrationActivities=ReturnType<typeof onlineMigrationActivities>;
