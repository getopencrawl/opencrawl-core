import type {SelfhostSettings} from './settings.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {ConnectorOAuth} from '../integrations/ports.mjs';
import type {ConnectorDefinition} from '../integrations/types.mjs';
import {createSingleOrganizationRegistry} from '../integrations/local-registry.mjs';
import {createIntegrations} from '../integrations/service.mjs';
import {createAirbyte} from '../integrations/airbyte.mjs';
import {createProviderCatalog} from '../integrations/providers.mjs';
import {connectorManifest} from '../integrations/manifests.mjs';
import {createConnectorResolver} from '../integrations/resolver.mjs';
import {createConnectorSearch} from '../connectors/search.mjs';
import {singleOrganizationStorage,singleOrganizationDestination} from '../integrations/single-organization-storage.mjs';
import {createGitHubApp,githubAppSettings} from '../integrations/github.mjs';
import {credentialVault} from '../integrations/credential-vault.mjs';
import {createSlackOAuth} from '../integrations/slack-oauth.mjs';
import {createComposioOAuth} from '../integrations/composio.mjs';
export function selfhostServices(settings:SelfhostSettings,store:ReturnType<typeof createObjectStore>,env:NodeJS.ProcessEnv=process.env){
  const required=(key:string)=>{const value=env[key];if(!value)throw new Error(`${key} is required`);return value;};
  const workspaceId=required('AIRBYTE_WORKSPACE_ID');if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workspaceId))throw new Error('Invalid Airbyte workspace');
  const airbyte=createAirbyte({url:required('AIRBYTE_URL'),clientId:required('AIRBYTE_CLIENT_ID'),clientSecret:required('AIRBYTE_CLIENT_SECRET')});
  const registry=createSingleOrganizationRegistry({path:settings.registryPath,organizationId:settings.organizationId});
  const buckets=singleOrganizationStorage(settings.organizationId,store);
  const destination=singleOrganizationDestination({organizationId:settings.organizationId,bucket:store.bucket,region:env.OPENCRAWL_LANDING_S3_REGION||'us-east-1',endpoint:env.OPENCRAWL_AIRBYTE_S3_ENDPOINT||env.OPENCRAWL_LANDING_S3_ENDPOINT,
    accessKeyId:required('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID'),secretAccessKey:required('OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY'),definitionId:env.AIRBYTE_S3_DESTINATION_DEFINITION_ID});
  const definitions:Record<string,ConnectorDefinition>=Object.fromEntries(['slack','googledrive','notion','circleback','granola'].map(id=>[id,{name:`OpenCrawl ${id} (operator-owned)`,manifest:connectorManifest(id)}]));
  const githubConfig=githubAppSettings(env.GITHUB_APP||null),github=githubConfig?createGitHubApp(githubConfig):null;
  definitions.github={name:'OpenCrawl GitHub (app)',docker:{repository:env.AIRBYTE_GITHUB_REPOSITORY||'opencrawl/source-github',tag:env.AIRBYTE_GITHUB_TAG||'local'}};
  let oauth:ReturnType<typeof createSlackOAuth>|undefined;
  if(env.SLACK_CLIENT_ID||env.SLACK_CLIENT_SECRET){
    const encoded=required('OPENCRAWL_CONNECTOR_KEY'),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)throw new Error('OPENCRAWL_CONNECTOR_KEY must be a base64-encoded 32-byte key');
    oauth=createSlackOAuth({organizationId:settings.organizationId,url:settings.url,proxyUrl:env.OPENCRAWL_AIRBYTE_APP_URL||settings.url,clientId:required('SLACK_CLIENT_ID'),clientSecret:required('SLACK_CLIENT_SECRET'),vault:credentialVault({store,prefix:'connector-credentials/v1',organizationId:settings.organizationId,key}),registry});
    definitions.slack={name:'OpenCrawl Slack (operator OAuth)',manifest:connectorManifest('slack')};
  }
  const disabled=async():Promise<never>=>{throw new Error('Configure operator-owned connector OAuth');};
  const unavailable:ConnectorOAuth={authConfig:disabled,link:disabled,account:disabled,remove:disabled,proxy:disabled,sourceConfiguration:disabled};
  const broker=env.COMPOSIO_API_KEY?createComposioOAuth({apiKey:env.COMPOSIO_API_KEY,organizationId:settings.organizationId}):undefined;
  // Existing grants retain their original adapter even if another is configured.
  const byGrant=(id:string)=>/^grant_[a-f0-9]{48}$/.test(id)?oauth||unavailable:broker||unavailable;
  const authorization:ConnectorOAuth={
    authConfig:input=>(input.toolkit==='slack'&&oauth?oauth:broker||unavailable).authConfig(input),
    link:input=>(input.authConfigId==='slack'?oauth||unavailable:broker||unavailable).link(input),
    account:id=>byGrant(id).account(id),remove:id=>byGrant(id).remove(id),
    proxy:input=>byGrant(input.connectedAccountId).proxy(input),
    sourceConfiguration:(record,provider)=>byGrant(record.connectedAccountId||'').sourceConfiguration(record,provider),
  };
  const providers=createProviderCatalog(definitions);
  const setup:Record<string,{title:string;body:string}>={};
  for(const id of ['googledrive','notion','circleback',...(!oauth?['slack']:[])])if(!broker)setup[id]={title:`Set up ${providers[id]!.name}`,body:'Your instance administrator can enable this connection with an operator-owned Composio project. Set COMPOSIO_API_KEY in the server configuration and restart the app. Then return here to authorize access to your account.'};
  if(!oauth&&!broker)setup.slack={title:'Set up Slack',body:'Your instance administrator can configure a Slack OAuth app with SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, or use an operator-owned Composio project with COMPOSIO_API_KEY. Restart the app after configuring it, then return here to connect Slack.'};
  if(!github)setup.github={title:'Set up GitHub',body:'Your instance administrator needs to configure a read-only GitHub App with GITHUB_APP and register the GitHub source image in Airbyte. The self-hosting guide in this repository lists the permissions and callback URL. Restart the app after configuring it, then return here to choose repositories.'};
  const product=createIntegrations({environment:'selfhost',appUrl:settings.url,registry,buckets,legacyBucket:store.bucket,workspaceId:async()=>workspaceId,destination,airbyte,oauth:authorization,providers,github});
  const integrations:ReturnType<typeof createIntegrations>={...product,
    async list(principal){return (await product.list(principal)).map(card=>setup[card.provider]?{...card,state:'setup-required' as const,setup:setup[card.provider]}:card);},
    async connect(principal,id,input){if(setup[id])throw Object.assign(new Error(setup[id].body),{status:503,expose:true});return product.connect(principal,id,input);},
  };
  const connectors=createConnectorResolver({environment:'selfhost',generation:'v1',registry,
    async storage(record){destination.validate(record);return store;},search:tenantId=>{if(tenantId!==settings.organizationId)throw new Error('Workspace scope denied');return createConnectorSearch(settings.search);}});
  async function recover(){
    const failures:unknown[]=[];
    for(const record of await registry.listTenant(settings.organizationId)){
      try{await integrations.recoverRecord(record);}catch(error){failures.push(error);}
    }
    if(failures.length)throw new AggregateError(failures,'Some connections still require recovery');
  }
  return {registry,integrations,providers,connectors,oauth,recover,close:registry.close};
}
