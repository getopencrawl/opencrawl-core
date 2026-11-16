import {createHash} from 'node:crypto';
import type {OnlineMigrationBinding,OnlineMigrationReference} from './types.mjs';
export function onlineMigrationBindingId(binding:OnlineMigrationBinding){
 if(!binding||Object.keys(binding).sort().join(',')!=='epoch,shards,sourceId,targetId'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding.epoch)||!/^(?:(?:s3|dynamodb):)?[a-f0-9]{64}(?![\s\S])/.test(binding.sourceId)||!/^[a-f0-9]{64}$/.test(binding.targetId)||!Number.isSafeInteger(binding.shards)||binding.shards<1||binding.shards>256)throw Error('Invalid online migration binding');
 return createHash('sha256').update(JSON.stringify(['online-app-state-v1',binding.epoch,binding.sourceId,binding.targetId,binding.shards])).digest('hex');
}
export function onlineMigrationReference(binding:OnlineMigrationBinding,shard:number):OnlineMigrationReference{
 const bindingId=onlineMigrationBindingId(binding);if(!Number.isSafeInteger(shard)||shard<0||shard>=binding.shards)throw Error('Invalid online migration shard');return {bindingId,shard};
}
export function onlineMigrationTaskQueue(binding:OnlineMigrationBinding){return 'application-state-shadow-v1-'+onlineMigrationBindingId(binding);}
export function onlineMigrationWorkflowId(reference:OnlineMigrationReference){
 if(!reference||Object.keys(reference).sort().join(',')!=='bindingId,shard'||!/^[a-f0-9]{64}$/.test(reference.bindingId)||!Number.isSafeInteger(reference.shard)||reference.shard<0||reference.shard>255)throw Error('Invalid online migration reference');
 return 'application-state-shadow-v1-'+reference.bindingId+'-'+reference.shard;
}
