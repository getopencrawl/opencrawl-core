import type {SelfhostSettings} from './settings.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {ConnectorOAuth,LandingDestination} from '../integrations/ports.mjs';
import type {ConnectorDefinition} from '../integrations/types.mjs';
import {createSingleOrganizationRegistry} from '../integrations/local-registry.mjs';
import {createIntegrations} from '../integrations/service.mjs';
import {createLocalAirbyte} from '../integrations/local-airbyte.mjs';
import type {ConnectorRunner} from '../integrations/connector-runner.mjs';
import {createProviderCatalog} from '../integrations/providers.mjs';
import {connectorManifest} from '../integrations/manifests.mjs';
import {createConnectorResolver} from '../integrations/resolver.mjs';
import {createConnectorSearch} from '../connectors/search.mjs';
import {singleOrganizationStorage,singleOrganizationDestination} from '../integrations/single-organization-storage.mjs';
import {createGitHubApp,githubAppSettings} from '../integrations/github.mjs';
import {credentialVault} from '../integrations/credential-vault.mjs';
import {createSlackOAuth} from '../integrations/slack-oauth.mjs';
// The bundled connector runtime keeps one fixed workspace; ids never leave this installation.
const WORKSPACE='00000000-0000-0000-0000-000000000001';
/** The app enqueues connector jobs; only the worker passes a runner and executes them. */
export function selfhostServices(settings:SelfhostSettings,store:ReturnType<typeof createObjectStore>,env:NodeJS.ProcessEnv=process.env,{runner}:{runner?:ConnectorRunner}={}){
  const required=(key:string)=>{const value=env[key];if(!value)throw new Error(`${key} is required`);return value;};
  const encoded=required('OPENCRAWL_CONNECTOR_KEY'),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)throw new Error('OPENCRAWL_CONNECTOR_KEY must be a base64-encoded 32-byte key');
  const registry=createSingleOrganizationRegistry({path:settings.registryPath,organizationId:settings.organizationId});
  const buckets=singleOrganizationStorage(settings.organizationId,store);
  // Connector output lands through this process's own object store; no S3 credentials leave it.
  const {validate}=singleOrganizationDestination({organizationId:settings.organizationId,bucket:store.bucket,region:'us-east-1',accessKeyId:'local',secretAccessKey:'local'});
  const destination:LandingDestination={validate,async prepare(record){validate(record);return {airbyteLandingMode:'local'};},async settings(record){validate(record);return {configuration:{s3_bucket_path:record.s3Prefix}};}};
  const definitions:Record<string,ConnectorDefinition>={granola:{name:'OpenCrawl Granola (workspace API key)',manifest:connectorManifest('granola')}};
  const githubConfig=githubAppSettings(env.GITHUB_APP||null),github=githubConfig?createGitHubApp(githubConfig):null;
  if(github)definitions.github={name:'OpenCrawl GitHub (app)',docker:{repository:env.AIRBYTE_GITHUB_REPOSITORY||'opencrawl/source-github',tag:env.AIRBYTE_GITHUB_TAG||'local'}};
  let oauth:ReturnType<typeof createSlackOAuth>|undefined;
  if(env.SLACK_CLIENT_ID||env.SLACK_CLIENT_SECRET){
    oauth=createSlackOAuth({organizationId:settings.organizationId,url:settings.url,proxyUrl:env.OPENCRAWL_CONNECTOR_APP_URL||'http://app:8092',clientId:required('SLACK_CLIENT_ID'),clientSecret:required('SLACK_CLIENT_SECRET'),vault:credentialVault({store,prefix:'connector-credentials/v1',organizationId:settings.organizationId,key}),registry});
    definitions.slack={name:'OpenCrawl Slack (operator OAuth)',manifest:connectorManifest('slack')};
  }
  const disabled=async():Promise<never>=>{throw new Error('Configure operator-owned connector OAuth');};
  const unavailable:ConnectorOAuth={authConfig:disabled,link:disabled,account:disabled,remove:disabled,proxy:disabled,sourceConfiguration:disabled};
  const providers=createProviderCatalog(definitions);
  const airbyte=createLocalAirbyte({path:env.OPENCRAWL_CONNECTOR_STATE_PATH||'/data/connectors.sqlite',workspaceId:WORKSPACE,secretKey:key,definitions:Object.values(definitions),runner,store,
    log:(event,data)=>console.error(JSON.stringify({event,...data}))});
  const integrations=createIntegrations({environment:'selfhost',appUrl:settings.url,registry,buckets,legacyBucket:store.bucket,workspaceId:async()=>WORKSPACE,destination,airbyte,oauth:oauth||unavailable,providers,github});
  const connectors=createConnectorResolver({environment:'selfhost',generation:'v1',registry,
    async storage(record){destination.validate(record);return store;},search:tenantId=>{if(tenantId!==settings.organizationId)throw new Error('Workspace scope denied');return createConnectorSearch(settings.search);}});
  async function recover(){
    const failures:unknown[]=[];
    for(const record of await registry.listTenant(settings.organizationId)){
      try{await integrations.recoverRecord(record);}catch(error){failures.push(error);}
    }
    if(failures.length)throw new AggregateError(failures,'Some connections still require recovery');
  }
  return {registry,integrations,providers,connectors,oauth,airbyte,recover,close(){registry.close();airbyte.close();}};
}
