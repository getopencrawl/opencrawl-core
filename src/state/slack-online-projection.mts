import {normalizeOnlineConnectionScope,type OnlineConnectionScope} from './online-connection-scopes.mjs';
import type {ConnectorBinding} from '../connectors/types.mjs';
import {digest,validateBinding} from '../connectors/scope.mjs';
import type {IntegrationRecord} from '../integrations/types.mjs';
import {slackCaptureLegacyIdentity,normalizeSlackCaptureProjection,type SlackLegacyValue} from './slack-capture.mjs';

export interface OnlineSlackCaptureProjection {
 kind:'slack';domain:'slack-capture';identity:string[];key:string;binding:ConnectorBinding;value:SlackLegacyValue;
}
function fail(message:string):never{throw Object.assign(new Error('Online Slack projection: '+message),{code:'ONLINE_PROJECTION_CONFLICT'});}
/** Pure retained-state decoder. Registry ownership is explicit and independent
 * of the path's workspace/connection names; nothing here admits a runtime. */
export function decodeOnlineSlackCapture({key,bytes,bucket,registryRecords,tenantIds,connectionScope}:{
 key:string;bytes:Buffer|null;bucket:string;registryRecords:readonly IntegrationRecord[];tenantIds:readonly string[];connectionScope?:OnlineConnectionScope;
}):OnlineSlackCaptureProjection {
 if(bytes===null)fail('retained capture state cannot be deleted');
 if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>16*1024*1024)fail('capture state exceeds its supported bound');
 if(!bucket||!tenantIds.length||tenantIds.length>100000||new Set(tenantIds).size!==tenantIds.length)fail('invalid source ownership');
 const source=slackCaptureLegacyIdentity(key),value=normalizeSlackCaptureProjection(key,JSON.parse(bytes.toString('utf8')));
 const verified=connectionScope?normalizeOnlineConnectionScope(connectionScope):null;
 const matches=verified?(verified.provider==='slack'&&verified.prefix+'/'===source.prefix&&verified.bucket===bucket?[{tenantId:verified.tenantId,integrationId:verified.connectionId,workspace:verified.workspace}]:[]):registryRecords.filter(record=>record.provider==='slack'&&record.s3Prefix+'/'===source.prefix&&(record.s3Bucket||bucket)===bucket);
 if(matches.length!==1)fail('capture state requires exactly one original registry binding');
 const record=matches[0];if(!tenantIds.includes(record.tenantId))fail('registry owner is not enrolled');
 const binding:ConnectorBinding=validateBinding({tenantId:record.tenantId,connectionId:record.integrationId,workspaceId:record.workspace as string,provider:'slack',access:'team-public',rawPrefix:source.prefix});
 if(value.scope!==digest(binding))fail('capture scope differs from its registry binding');

 return {kind:'slack',domain:'slack-capture',identity:[source.prefix,value.scope,source.kind,source.catalog?'catalog':source.runId!],key,binding,value};
}
