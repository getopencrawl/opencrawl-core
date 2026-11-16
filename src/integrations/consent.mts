import type {IntegrationResources} from '../state/integration-resources.mjs';
import {createHash,randomBytes} from 'node:crypto';
import type {IntegrationRecord} from './types.mjs';
import type {ConnectorOAuth,IntegrationRegistry,OAuthLinkInput,OAuthLinkResult} from './ports.mjs';
const version=()=>randomBytes(16).toString('hex');
const pending=()=>Object.assign(new Error('Consent setup is waiting to reconcile an earlier provider request'),{code:'ConsentRecoveryPending',status:503});
const validId=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=200&&!/[\x00-\x20\x7f]/.test(id);
const conflict=()=>Object.assign(new Error('Consent setup changed'),{code:'ConditionalCheckFailedException',status:409});
type Intent=NonNullable<IntegrationRecord['oauthIntent']>;
/** A provider POST gets one durable intent. An empty or incomplete provider list
 * cannot authorize a second POST, including after activity/process replacement. */
export function createConsentProvisioning({registry,oauth,resources}:{registry:IntegrationRegistry;oauth:ConnectorOAuth;resources?:IntegrationResources}){
 async function fresh(expected:IntegrationRecord){
  const current=await registry.get(expected.tenantId,expected.userId,expected.integrationId);
  if(!current||current.environment!==expected.environment||current.provider!==expected.provider)throw conflict();return current;
 }
 const save=(current:IntegrationRecord,fields:Partial<IntegrationRecord>)=>registry.update(current,{...fields,oauthVersion:version()},
  {whenStatus:[current.status],whenFields:{oauthVersion:current.oauthVersion,oauthIntent:current.oauthIntent,lifecycleCommandId:current.lifecycleCommandId}});
 async function claim(expected:IntegrationRecord,resource:Intent['resource'],callbackUrl?:string,config?:Intent['config']){
  const current=await fresh(expected);
  if(current.status!=='connecting'||current.lifecycleOperation!=='consent'||current.lifecycleCommandId!==expected.lifecycleCommandId||current.oauthIntent)throw conflict();
  const intent:Intent={resource,attemptId:version(),requestedAt:new Date().toISOString(),...(callbackUrl?{callbackUrl}:{}),...(config?{config}:{})};
  return {record:await save(current,{oauthIntent:intent,...(resource==='link'?{oauthLinkAttemptId:intent.attemptId}:{})}),intent};
 }
 async function remember(expected:IntegrationRecord,intent:Intent,fields:Partial<IntegrationRecord>){
  for(let i=0;i<8;i++){
   const current=await fresh(expected);
   if(!current.oauthIntent&&Object.entries(fields).every(([key,value])=>current[key as keyof IntegrationRecord]===value))return current;
   if(current.oauthIntent?.attemptId!==intent.attemptId)throw conflict();
   try{return await save(current,{...fields,oauthIntent:null,...(intent.resource==='link'?{resourceVersion:version(),...(['abandoned','disconnecting','disconnected'].includes(current.status)?{dataDeletedAt:null}:{})}:{})});}
   catch(error){if((error as {code?:string}).code!=='ConditionalCheckFailedException')throw error;}
  }
  throw conflict();
 }
 async function authConfig(expected:IntegrationRecord,input:Parameters<ConnectorOAuth['authConfig']>[0]){
  let record=await fresh(expected);
  if(record.authConfigId&&!record.oauthIntent)return record;
  if(record.oauthIntent){
   if(record.oauthIntent.resource!=='auth-config')throw conflict();
   const id=await oauth.recoverAuthConfig?.(record.oauthIntent.config??input);if(!validId(id))throw pending();
   return remember(record,record.oauthIntent,{authConfigId:id});
  }
  const held=await claim(record,'auth-config',undefined,{toolkit:input.toolkit,name:input.name,...(input.scheme?{scheme:input.scheme}:{})});record=held.record;
  const fingerprint=createHash('sha256').update(JSON.stringify([input.toolkit,input.name,input.scheme??null])).digest('hex');
  if(!resources)throw new Error('Durable shared integration resources are not configured');
  const id=await resources.ensure({kind:'oauth-auth-config',scope:record.tenantId,name:input.name,fingerprint},{
   find:async()=>{const id=await oauth.recoverAuthConfig?.(input);return id?{id,fingerprint}:null;},create:()=>oauth.authConfig(input),
  });
  if(!validId(id))throw pending();
  return remember(record,held.intent,{authConfigId:id});
 }
 async function link(expected:IntegrationRecord,input:Omit<OAuthLinkInput,'requestId'>):Promise<{record:IntegrationRecord;result:OAuthLinkResult}>{
  let record=await fresh(expected);
  if(record.connectedAccountId&&!record.oauthIntent){
   const recovered=record.oauthLinkAttemptId?await oauth.recoverLink?.({...input,requestId:record.oauthLinkAttemptId}):null;
   if(recovered&&recovered.connected_account_id!==record.connectedAccountId)throw pending();
   return {record,result:recovered??{connected_account_id:record.connectedAccountId}};
  }
  if(record.oauthIntent){
   if(record.oauthIntent.resource!=='link'||record.oauthIntent.callbackUrl!==input.callbackUrl)throw conflict();
   const result=await oauth.recoverLink?.({...input,requestId:record.oauthIntent.attemptId});if(!result||!validId(result.connected_account_id))throw pending();
   record=await remember(record,record.oauthIntent,{connectedAccountId:result.connected_account_id});return {record,result};
  }
  const held=await claim(record,'link',input.callbackUrl);record=held.record;
  const result=await oauth.link({...input,requestId:held.intent.attemptId});
  if(!validId(result?.connected_account_id))throw pending();
  record=await remember(record,held.intent,{connectedAccountId:result.connected_account_id});return {record,result};
 }
 /** Cleanup only adopts a previously requested resource. It never creates one. */
 async function reconcile(expected:IntegrationRecord,config:Parameters<ConnectorOAuth['authConfig']>[0],userId:string){
  const record=await fresh(expected),intent=record.oauthIntent;if(!intent)return record;
  if(intent.resource==='auth-config'){
   const id=await oauth.recoverAuthConfig?.(intent.config??config);if(!validId(id))throw pending();return remember(record,intent,{authConfigId:id});
  }
  if(!record.authConfigId||!intent.callbackUrl)throw pending();
  const result=await oauth.recoverLink?.({authConfigId:record.authConfigId,userId,callbackUrl:intent.callbackUrl,requestId:intent.attemptId});
  if(!result||!validId(result.connected_account_id))throw pending();return remember(record,intent,{connectedAccountId:result.connected_account_id});
 }
 return {authConfig,link,reconcile};
}
