import {open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import type {PoolClient} from 'pg';
import type {ApplicationDatabase} from './postgres.mjs';
import {requireApplicationStateReady} from './postgres.mjs';
import {createIntegrationCommands} from './integration-commands.mjs';
import {applicationDatabase} from './settings.mjs';
import {sealedEnvelope,connectorGrantSchema,GRANT_ID} from '../integrations/credential-vault.mjs';
import type {IntegrationRecord} from '../integrations/types.mjs';
import {digest} from '../connectors/scope.mjs';
const fail=(code:string):never=>{throw Object.assign(new Error('Slack grant settlement requires current scoped operator evidence'),{code});};
interface Evidence {version:1;fingerprint:string;verifiedBy:string;exchangeDisposition:string;providerRevocation:string}
function evidence(value:unknown):Evidence{
 const item=value as Evidence;
 if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='exchangeDisposition,fingerprint,providerRevocation,verifiedBy,version'||item.version!==1||!/^[a-f0-9]{64}$/.test(item.fingerprint)
  ||typeof item.verifiedBy!=='string'||!item.verifiedBy.trim()||item.verifiedBy.length>200||[item.exchangeDisposition,item.providerRevocation].some(value=>typeof value!=='string'||!value.trim()||value.length>3000))fail('SLACK_SETTLEMENT_EVIDENCE_INVALID');return item;
}
async function readEvidence(path:string){const file=await open(path,'r').catch(()=>fail('SLACK_SETTLEMENT_EVIDENCE_INVALID'));try{if(!(await file.stat()).isFile())fail('SLACK_SETTLEMENT_EVIDENCE_INVALID');const buffer=Buffer.alloc(16385),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>16384)fail('SLACK_SETTLEMENT_EVIDENCE_INVALID');try{return evidence(JSON.parse(buffer.subarray(0,bytesRead).toString()));}catch{return fail('SLACK_SETTLEMENT_EVIDENCE_INVALID');}}finally{await file.close();}}
/** Separate from Airbyte storage evidence: this binds the exact encrypted Slack
 * grant revision and in-flight token request. It never contacts the issuer. */
export async function runSlackGrantSettlementCommand({database,organizationId,key,args}:{database:ApplicationDatabase;organizationId:string;key:Uint8Array;args:string[]}){
 const [operation,...flags]=args,options:Record<string,string>={};
 if(!['inspect','record'].includes(operation)||flags.length%2||!/^org_[A-Za-z0-9]+$/.test(organizationId)||key.length!==32)fail('SLACK_SETTLEMENT_USAGE');
 for(let i=0;i<flags.length;i+=2){if(!['--integration','--owner','--evidence'].includes(flags[i])||options[flags[i]]||!flags[i+1])fail('SLACK_SETTLEMENT_USAGE');options[flags[i]]=flags[i+1];}
 if(!/^int_[a-f0-9]{26}$/.test(options['--integration']||'')||!/^user_[A-Za-z0-9]+$/.test(options['--owner']||'')||operation==='record'&&!options['--evidence']||operation==='inspect'&&options['--evidence'])fail('SLACK_SETTLEMENT_USAGE');
 await requireApplicationStateReady(database);const verified=operation==='record'?await readEvidence(options['--evidence']):null,envelope=sealedEnvelope(key);
 const scoped=[database.namespace,'selfhost',organizationId,options['--owner'],options['--integration']];
 async function inspect(client:Pick<PoolClient,'query'>,lock=false){
  const row=(await client.query('SELECT record FROM opencrawl_integrations WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5'+(lock?' FOR UPDATE':''),scoped)).rows[0];
  const record=row?.record as IntegrationRecord|undefined;
  if(!record||record.environment!=='selfhost'||record.tenantId!==organizationId||record.userId!==options['--owner']||record.integrationId!==options['--integration']||record.provider!=='slack'||!GRANT_ID.test(record.connectedAccountId||''))fail('SLACK_SETTLEMENT_SCOPE_NOT_FOUND');
  const id=record!.connectedAccountId!,aad=`connector-credentials/v1/${organizationId}/${id}.enc`;
  const saved=(await client.query("SELECT aad,ciphertext,revision FROM opencrawl_connector_secrets WHERE namespace=$1 AND kind='grant' AND organization_id=$2 AND secret_id=$3"+(lock?' FOR UPDATE':''),[database.namespace,organizationId,id])).rows[0];
  if(!saved||saved.aad!==aad)fail('SLACK_SETTLEMENT_SCOPE_NOT_FOUND');
  const grant=connectorGrantSchema.parse(JSON.parse(envelope.open(aad,saved.ciphertext).toString()));
  if(grant.id!==id||grant.organizationId!==organizationId||grant.userId!==record!.userId||grant.integrationId!==record!.integrationId)fail('SLACK_SETTLEMENT_SCOPE_NOT_FOUND');
  const fingerprint=createHash('sha256').update(JSON.stringify(['slack-grant-settlement-v1',...scoped,id,record!.resourceVersion??null,saved.revision])).digest('hex');
  const fenceKey='control/connectors/write-barriers/v1/'+digest(['selfhost',organizationId,record!.integrationId])+'.json';
  const fence=(await client.query('SELECT closed_at,barrier_namespace,tenant_id,resource_id FROM opencrawl_write_fences WHERE namespace=$1 AND fence_key=$2'+(lock?' FOR UPDATE':''),[database.namespace,fenceKey])).rows[0];
  const pending=(await client.query("SELECT 1 FROM opencrawl_resource_writers WHERE namespace=$1 AND fence_key=$2 AND phase='writing' LIMIT 1",[database.namespace,fenceKey])).rowCount!==0;
  return {record:record!,grant,saved,id,aad,fingerprint,nativeClosed:fence?.closed_at!=null&&fence.barrier_namespace==='selfhost'&&fence.tenant_id===organizationId&&fence.resource_id===record!.integrationId,nativePending:pending};
 }
 if(verified)await database.transaction(async client=>{
  const current=await inspect(client,true);
  if(current.fingerprint!==verified.fingerprint)fail('SLACK_SETTLEMENT_TARGET_CHANGED');
  if(!['disconnecting','disconnected','abandoned'].includes(current.record.status)||current.record.oauthIntent||current.record.provisionIntent||current.grant.status!=='REVOKED'||!current.nativeClosed||current.nativePending)fail('SLACK_SETTLEMENT_NOT_READY');
  // Positive operator evidence covers the unknown prior request, not future
  // requests. Keep every known token queued for normal verified revocation.
  const grant=connectorGrantSchema.parse({...current.grant,tokenIntent:undefined,legacyTokenUncertainty:false,tokenProtocol:1,remoteRevoked:false,settlementProof:{...verified,verifiedAt:new Date().toISOString()}});
  const ciphertext=envelope.seal(current.aad,Buffer.from(JSON.stringify(grant)));if(ciphertext.length>262144)fail('SLACK_SETTLEMENT_EVIDENCE_INVALID');
  await client.query("UPDATE opencrawl_connector_secrets SET ciphertext=$4,revision=$5 WHERE namespace=$1 AND kind='grant' AND organization_id=$2 AND secret_id=$3 AND revision=$6",[database.namespace,organizationId,current.id,ciphertext,randomUUID(),current.saved.revision]);
  const commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey:key}).transactional;
  const reference={environment:'selfhost' as const,tenantId:organizationId,userId:current.record.userId,integrationId:current.record.integrationId,commandId:current.record.lifecycleCommandId||''};
  const existing=reference.commandId?await commands.read(client,reference):null;
  if(existing?.operation!=='disconnect'||existing.status!=='pending'){
   if(existing?.status==='pending')fail('SLACK_SETTLEMENT_NOT_READY');
   reference.commandId='grantproof_'+createHash('sha256').update(JSON.stringify([...scoped,verified.fingerprint])).digest('hex');
   await commands.enqueue(client,reference,'disconnect',{},current.record.userId);
   const status=current.record.status==='abandoned'?'abandoned':'disconnecting';
   await client.query("UPDATE opencrawl_integrations SET status=$6,revision=revision+1,record=record||jsonb_build_object('status',$6::text,'lifecycleOperation','disconnect','lifecycleCommandId',$7::text) WHERE namespace=$1 AND environment=$2 AND tenant_id=$3 AND user_id=$4 AND integration_id=$5",[...scoped,status,reference.commandId]);
  }

 });
 const current=await inspect(database.pool);
 return {version:1,operation,namespace:database.namespace,environment:'selfhost',tenantId:organizationId,userId:options['--owner'],integrationId:options['--integration'],grantId:current.id,workspaceId:current.record.workspace??null,fingerprint:current.fingerprint,status:current.grant.status,
  uncertainty:{tokenExchange:!!current.grant.tokenIntent,legacyTokens:!!current.grant.legacyTokenUncertainty},native:{closed:current.nativeClosed,pending:current.nativePending},proof:current.grant.settlementProof?{recorded:true,verifiedAt:current.grant.settlementProof.verifiedAt}:{recorded:false}};
}
async function main(){const database=applicationDatabase();try{const encoded=process.env.OPENCRAWL_CONNECTOR_KEY||'',key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)fail('SLACK_SETTLEMENT_USAGE');console.log(JSON.stringify(await runSlackGrantSettlementCommand({database,organizationId:process.env.OPENCRAWL_ORGANIZATION_ID||'',key,args:process.argv.slice(2)})));}finally{await database.close();}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main().catch(error=>{console.error(JSON.stringify({ok:false,code:typeof error?.code==='string'&&/^SLACK_SETTLEMENT_[A-Z_]+$/.test(error.code)?error.code:'SLACK_SETTLEMENT_FAILED'}));process.exitCode=1;});
