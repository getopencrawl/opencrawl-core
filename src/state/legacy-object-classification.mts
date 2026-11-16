import {SESSION_HARNESSES} from '../sessions/types.mjs';
import {sourceBatchIdentity,MAX_EVENT_LEDGER_BYTES} from '../sessions/event-identity.mjs';
import {memorySourceIdentity} from '../memories/snapshot.mjs';

const H='[a-f0-9]{64}',U='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export interface LegacyObjectClassification {domain:string;maxBytes:number;parts:string[]}
function fail(message:string):never{throw Object.assign(new Error(message),{code:'APPLICATION_MIGRATION_UNSAFE'});}

/** Shared legacy format classification, not resource authorization. An enrolled
 * compatibility runtime retains its existing authorization at every operation.
 * Offline migration additionally binds immutable objects to its reviewed owner
 * inventory through validateRawTenantHash. Unknown mutable paths fail closed. */
export function createLegacyObjectClassifier({prefix,credentialPurpose='capture',validateRawTenantHash}:{
  prefix:string;credentialPurpose?:'capture'|'agent';validateRawTenantHash?:(hash:string)=>void;
}){
  if(!prefix||prefix.length>8192||prefix.includes('\0')||prefix.split('/').some(part=>!part||part==='.'||part==='..')||!['capture','agent'].includes(credentialPurpose))fail('Invalid object classification scope');
  const roots=credentialPurpose==='agent'?[prefix+'/']:[prefix+'/', 'control/connectors/write-barriers/v1/','connector-credentials/v1/','connector-settings/v1/','derived/indexing/','raw/v1/source=slack/','_opencrawl/counts/'];
  function classify(key:string):LegacyObjectClassification|null {
    if(typeof key!=='string'||key.length>8192||key.includes('\0')||key.split('/').some(part=>!part||part==='.'||part==='..'))fail('Invalid object migration key');
    const match=(pattern:RegExp,domain:string,maxBytes=65536):LegacyObjectClassification|null=>{const value=pattern.exec(key.startsWith(prefix+'/')?key.slice(prefix.length+1):key);return value?{domain,maxBytes,parts:value.slice(1)}:null;};
    if(key.startsWith(prefix+'/')){
      const raw=key.slice(prefix.length+1);
      if(credentialPurpose==='agent'&&!new RegExp(`^(?:_credentials/${H}|_credential-generations/tenants/${H}/users/${H})\\.json$`).test(raw))fail('Agent credential source contains unrelated application state');
      const source=sourceBatchIdentity(prefix,key)??memorySourceIdentity(prefix,key);
      if(source){validateRawTenantHash?.(source.tenantHash);return null;}
      const attachment=new RegExp(`^tenants/(${H})/users/${H}/(?:(?:${SESSION_HARNESSES.join('|')})/${H}/${H}/)?attachments/${H}$`).exec(raw);
      if(attachment){validateRawTenantHash?.(attachment[1]);return null;}
      const found=match(new RegExp(`^board/tenants/(${H})\\.json$`),'board',16*1024*1024)
        ??match(new RegExp(`^tenants/(${H})/users/(${H})/controls/(sessions|memories)/([^/]+)/(${H})\\.json$`),'resource-controls')
        ??match(new RegExp(`^tenants/(${H})/users/(${H})/controls/write-barriers/(${H})\\.json$`),'session-write-fences',16*1024*1024)
        ??match(new RegExp(`^_deletions/v1/(${H})\\.json$`),'deletion-requests')
        ??match(new RegExp(`^_credentials/(${H})\\.json$`),'capture-credentials')
        ??match(new RegExp(`^_credential-generations/(tenants/(${H})/users/${H})\\.json$`),'credential-generations')
        ??match(/^organization-role-writes\/(org_[A-Za-z0-9]+)\.json$/,'role-writes')
        ??match(new RegExp(`^identity/replicas-v1/organizations/(${U})\\.json$`),'replicas-connections')
        ??match(new RegExp(`^identity/replicas-v1/tenants/(${H})/(${U})\\.json$`),'replicas-index')
        ??match(new RegExp(`^identity/replicas-v1/setup/(${H})\\.json$`),'replicas-setup')
        ??match(new RegExp(`^(tenants/(${H})/users/${H})/onboarding/(cli|mcp|mcpTest|session|history|completed)\\.json$`),'onboarding')
        ??match(new RegExp(`^value/tenants/(${H})\\.json$`),'value-reports')
        ??match(new RegExp(`^index-pending/tenants/(${H})/users/(${H})/(${H})\\.json$`),'session-scheduler-retirement',32768)
        ??match(new RegExp(`^_index/${H}/${H}/(cursor|reconcile)\\.json$`),'session-scheduler-retirement',32768)
        ??match(new RegExp(`^_index/${H}/${H}/batches/(${H})\\.json$`),'session-indexing',32768)
        ??match(new RegExp(`^_index/temporal-cutover/(${H})\\.json$`),'temporal-cutover',32768)
        ??match(new RegExp(`^tenants/(${H})/users/${H}/(?:${SESSION_HARNESSES.join('|')})/${H}/${H}/event-identities-v1\\.json$`),'event-identities',MAX_EVENT_LEDGER_BYTES);
      if(found){if(credentialPurpose==='agent'&&!['capture-credentials','credential-generations'].includes(found.domain))fail('Agent credential source contains unrelated application state');return found;}
      fail('Unrecognized object under the application source prefix; retain it and add a reviewed migration');
    }
    if(credentialPurpose==='agent')fail('Agent credential source escaped its bound prefix');
    const found=match(new RegExp(`^control/connectors/write-barriers/v1/(${H})\\.json$`),'connector-write-fences',16*1024*1024)
      ??match(/^connector-credentials\/v1\/(org_[A-Za-z0-9]+)\/(grant_[a-f0-9]{48})\.enc$/,'connector-grants')
      ??match(/^connector-settings\/v1\/(org_[A-Za-z0-9]+)\/settings\.enc$/,'connector-settings')
      ??match(new RegExp(`^derived/indexing/([A-Za-z0-9_-]+)/${H}/(${H})\\.json$`),'connector-indexing',32768)
      ??match(new RegExp(`^derived/indexing/([A-Za-z0-9_-]+)/${H}/snapshot-(${H})\\.json$`),'connector-snapshots',32768)
      ??match(/^_opencrawl\/counts\/connection=(int_[a-f0-9]{26})\.json\.gz$/,'record-counts',64*1024*1024)
      ??match(/^raw\/v1\/source=slack\/workspace=[A-Za-z0-9_:-]{1,200}\/connection=[A-Za-z0-9_:-]{1,200}\/capture\/(files-v1|messages-v1|message-references-v1)\/(?:catalog\.json|[A-Za-z0-9_-]{1,150}\/state\.json)$/,'slack-capture',16*1024*1024);
    if(found)return found;
    if(/^raw\/v1\/source=slack\/workspace=[A-Za-z0-9_:-]{1,200}\/connection=[A-Za-z0-9_:-]{1,200}\/(?:stream=[A-Za-z0-9_-]+\/date=\d{4}-\d{2}-\d{2}\/sync=[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.jsonl\.gz|files\/sha256\/[a-f0-9]{64}\.bin|capture\/(?:files-v1|messages-v1|message-references-v1)\/[A-Za-z0-9_-]{1,150}\/pages\/[a-f0-9]{64}\.json)$/.test(key))return null;
    if(roots.some(root=>key.startsWith(root)))fail('Unrecognized object under a mutable state namespace; retain it and add a reviewed migration');
    return null;
  }
  return {roots,classify};
}
