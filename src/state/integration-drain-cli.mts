import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import type {ApplicationDatabase} from './postgres.mjs';
import {requireApplicationStateReady} from './postgres.mjs';
import {applicationDatabase} from './settings.mjs';
import {createIntegrationDrainProofs} from './integration-drain-proofs.mjs';
import {createPostgresWriteBarrier} from './write-barriers.mjs';
import type {Environment,IntegrationRecord} from '../integrations/types.mjs';
const failure=(code:string,message:string)=>Object.assign(new Error(message),{code});
const invalid=()=>failure('DRAIN_EVIDENCE_INVALID','Evidence must identify the inspected fingerprint, operator, terminated writers and settled storage writes');
export interface IntegrationDrainEvidence {version:1;fingerprint:string;verifiedBy:string;writerTermination:string;storageSettlement:string}
function evidence(value:unknown):IntegrationDrainEvidence{
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
 const item=value as IntegrationDrainEvidence;
 if(Object.keys(item).sort().join(',')!=='fingerprint,storageSettlement,verifiedBy,version,writerTermination'||item.version!==1||!(/^[a-f0-9]{64}$/).test(item.fingerprint)
  ||typeof item.verifiedBy!=='string'||!item.verifiedBy.trim()||item.verifiedBy.length>200
  ||[item.writerTermination,item.storageSettlement].some(v=>typeof v!=='string'||!v.trim()||v.length>3000))throw invalid();
 return item;
}
async function readEvidence(path:string){
 const handle=await open(path,'r').catch(()=>{throw invalid();});
 try{
  if(!(await handle.stat()).isFile())throw invalid();
  const buffer=Buffer.alloc(16385),{bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>16384)throw invalid();
  try{return evidence(JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')));}catch{throw invalid();}
 }finally{await handle.close();}
}
function argumentsOf(args:string[]){
 const [operation,...flags]=args,values:Record<string,string>={};
 if(!['inspect','record'].includes(operation)||flags.length%2)throw failure('DRAIN_USAGE','Use inspect|record --integration ID --owner USER [--evidence FILE]');
 for(let i=0;i<flags.length;i+=2){const flag=flags[i];if(!['--integration','--owner','--evidence'].includes(flag)||values[flag]!==undefined||!flags[i+1])throw failure('DRAIN_USAGE','Invalid or duplicate drain command option');values[flag]=flags[i+1];}
 if(!/^int_[a-f0-9]{26}$/.test(values['--integration']||'')||!/^user_[A-Za-z0-9]+$/.test(values['--owner']||'')||operation==='record'&&!values['--evidence']||operation==='inspect'&&values['--evidence'])throw failure('DRAIN_USAGE','Provide an exact integration, owner and an evidence file only for record');
 return {operation,integrationId:values['--integration'],userId:values['--owner'],path:values['--evidence']};
}
/** Operator-only local command. Inspection performs SELECTs only. Recording
 * never contacts a provider or infers settlement from cancellation or elapsed time. */
export async function runIntegrationDrainCommand({database,organizationId,args,environment='selfhost'}:{database:ApplicationDatabase;organizationId:string;args:string[];environment?:Environment}){
 const command=argumentsOf(args);
 if(!['selfhost','production','staging'].includes(environment)||!(environment==='selfhost'?/^org_[A-Za-z0-9]+$/:/^(org_[A-Za-z0-9]+|personal:user_[A-Za-z0-9]+)$/).test(organizationId))throw failure('DRAIN_USAGE','Configure the installation organization');
 await requireApplicationStateReady(database);
 const params=[database.namespace,environment,organizationId,command.userId,command.integrationId];
 const {rows}=await database.pool.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5',params);
 const record=rows[0]?.record as IntegrationRecord|undefined;
 if(!record||record.environment!==environment||record.tenantId!==organizationId||record.userId!==command.userId||record.integrationId!==command.integrationId)throw failure('DRAIN_SCOPE_NOT_FOUND','Integration does not exist in this installation and owner scope');
 const proofs=createIntegrationDrainProofs({database,environment}),proof=await proofs.inspect(record);
 if(command.operation==='record'){
  const verified=await readEvidence(command.path);
  if(verified.fingerprint!==proof.fingerprint)throw failure('DRAIN_TARGET_CHANGED','Evidence fingerprint differs; inspect and independently verify the current resources');
  await proofs.recordVerifiedProof(record,{verifiedBy:verified.verifiedBy,evidence:JSON.stringify(verified)});
 }
 const native=await createPostgresWriteBarrier({database,namespace:environment,tenantId:organizationId,connectionId:record.integrationId}).inspect();
 return {version:1,operation:command.operation,namespace:database.namespace,environment,tenantId:organizationId,userId:record.userId,integrationId:record.integrationId,
  status:record.status,fingerprint:proof.fingerprint,resources:{version:record.resourceVersion??null,workspaceId:record.airbyteWorkspaceId??null,connectionId:record.airbyte?.connectionId??null,sourceId:record.airbyte?.sourceId??null,destinationId:record.airbyte?.destinationId??null,bucket:record.s3Bucket??database.sourceIdentity?.bucket??null,prefix:record.s3Prefix??null},
  pendingCreate:record.provisionIntent?{resource:record.provisionIntent.resource,attemptId:record.provisionIntent.attemptId}:null,
  native:{closed:native.closed,pending:native.pending,writers:native.writers.map(({id,operation,phase,startedAt,settledAt})=>({id,operation,phase,startedAt,...(settledAt===undefined?{}:{settledAt})}))},
  proof:await proofs.inspect(record)};
}
async function main(){
 const database=applicationDatabase();
 try{console.log(JSON.stringify(await runIntegrationDrainCommand({database,organizationId:process.env.OPENCRAWL_ORGANIZATION_ID||'',args:process.argv.slice(2)})));}
 finally{await database.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main().catch(error=>{
 const code=typeof error?.code==='string'&&/^(DRAIN_[A-Z_]+|EXTERNAL_WRITER_PROOF_REQUIRED)$/.test(error.code)?error.code:'DRAIN_COMMAND_FAILED';
 // Never print DB connection errors, provider payloads or evidence file contents.
 console.error(JSON.stringify({ok:false,code}));process.exitCode=1;
});
