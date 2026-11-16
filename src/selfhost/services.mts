import type {SelfhostSettings} from './settings.mjs';
import {airbyteEnabled} from './settings.mjs';
import type {createObjectStore} from '../sessions/s3-store.mjs';
import type {ConnectorOAuth} from '../integrations/ports.mjs';
import type {ConnectorDefinition,ProxyRequest,ProviderData} from '../integrations/types.mjs';
import type {ConnectorCredential,SourceSetup} from '../application/onboarding-types.mjs';
import type {SourceCredentialProxy} from '../integrations/proxy-http.mjs';
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
import {createSlackOAuth,slackOAuthManifest} from '../integrations/slack-oauth.mjs';
import {createComposioOAuth} from '../integrations/composio.mjs';
import {connectorSettingsStore} from '../integrations/connector-settings.mjs';
import {errorInfo} from '../errors.mjs';
import type {IdentityDirectory} from '../identity/types.mjs';
import {createDriveAccess,workspaceDriveAudience} from '../integrations/google-drive-access.mjs';
import type {ApplicationDatabase} from '../state/postgres.mjs';
import {createIntegrationResources} from '../state/integration-resources.mjs';
import {createIntegrationCommands} from '../state/integration-commands.mjs';
import type {ApplicationState} from '../state/types.mjs';
import type {IntegrationCommandReference,IntegrationCommand} from '../integrations/temporal/types.mjs';
import {createConnectorCounts} from '../state/connector-counts.mjs';
import {createIntegrationDrainProofs} from '../state/integration-drain-proofs.mjs';
import {createRecordCounts} from '../integrations/counts.mjs';
import {guardConnectorWrites} from '../connectors/write-barrier.mjs';
import {integrationLifecycleScheduler} from '../integrations/temporal/client.mjs';
import {connectorClient,ensureConnectorSchedule} from '../connectors/temporal/client.mjs';
import {digest} from '../connectors/scope.mjs';
import {eligible} from '../integrations/resolver.mjs';
import {activeMemberships} from '../identity/principal.mjs';
import {isAdmin} from '../identity/team.mjs';
import {createRealm} from '../search/realm.mjs';
import {selfhostTemporalSettings} from './temporal-settings.mjs';
export function selfhostServices(settings:SelfhostSettings,store:ReturnType<typeof createObjectStore>,env:NodeJS.ProcessEnv,database:ApplicationDatabase,state:ApplicationState,directory?:IdentityDirectory){
  if(!database||!state)throw new Error('Configure the application database and authoritative state');
  const encryptionKey=env.OPENCRAWL_CONNECTOR_KEY?Buffer.from(env.OPENCRAWL_CONNECTOR_KEY,'base64'):undefined;
  const commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey});
  const resources=createIntegrationResources({database,environment:'selfhost'});
  const registry=createSingleOrganizationRegistry({database,organizationId:settings.organizationId,commands:commands.transactional});
  const countRepository=createConnectorCounts({database,legacyBucket:store.bucket}),drainProofs=createIntegrationDrainProofs({database,environment:'selfhost'});
  const ready=async()=>{await resources.ready();await commands.ready();await registry.ready();await countRepository.ready();await drainProofs.ready();};
  const integrationSourceId='integrations-'+settings.organizationId+'-v1';
  const enabled=airbyteEnabled(env);
  const definitions:Record<string,ConnectorDefinition>=Object.fromEntries(['slack','googledrive','notion','circleback','granola'].map(id=>[id,{name:`OpenCrawl ${id} (operator-owned)`,manifest:connectorManifest(id)}]));
  definitions.github={name:'OpenCrawl GitHub (app)',docker:{repository:env.AIRBYTE_GITHUB_REPOSITORY||'opencrawl/source-github',tag:env.AIRBYTE_GITHUB_TAG||'local'}};
  if(!enabled){
    const providers=createProviderCatalog(definitions,{driveWorkspaceAccess:true});
    const body='External sources are disabled on this instance. Ask your administrator to enable Airbyte. Agent capture, memories, search and the board remain available.';
    const disabled=async():Promise<never>=>{throw Object.assign(new Error(body),{status:503,expose:true});};
    const integrations:ReturnType<typeof createIntegrations>={
      providers:()=>Object.values(providers),
      async list(principal){
        if(principal.tenantId!==settings.organizationId)throw Object.assign(new Error('Workspace scope denied'),{status:403});
        return Object.values(providers).map(provider=>({provider:provider.id,name:provider.name,description:provider.description,scope:provider.scope,units:provider.units,help:provider.help,
          auth:provider.auth==='api-key'?'api-key' as const:'oauth' as const,state:'setup-required' as const,
          setup:{title:'Enable external sources',requirement:'Airbyte disabled',body}}));
      },
      connect:disabled,complete:disabled,retry:disabled,disconnect:disabled,disconnectAll:disabled,recoverRecord:disabled,lifecycleStep:disabled,
    };
    return {registry,commands,ready,providers,integrations,connectors:undefined,oauth:undefined,sourceCredentials:undefined,connectorSettings:undefined,integrationSourceId,lifecycleActivities:undefined,countRepository,drainProofs,recover:async()=>{},close:registry.close};
  }
  const required=(key:string)=>{const value=env[key];if(!value)throw new Error(`${key} is required`);return value;};
  const workspaceId=required('AIRBYTE_WORKSPACE_ID');if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(workspaceId))throw new Error('Invalid Airbyte workspace');
  const airbyte=createAirbyte({url:required('AIRBYTE_URL'),clientId:required('AIRBYTE_CLIENT_ID'),clientSecret:required('AIRBYTE_CLIENT_SECRET')});
  const buckets=singleOrganizationStorage(settings.organizationId,store);
  const destination=singleOrganizationDestination({organizationId:settings.organizationId,bucket:store.bucket,region:env.OPENCRAWL_LANDING_S3_REGION||'us-east-1',endpoint:env.OPENCRAWL_AIRBYTE_S3_ENDPOINT||env.OPENCRAWL_LANDING_S3_ENDPOINT,
    accessKeyId:required('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID'),secretAccessKey:required('OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY'),definitionId:env.AIRBYTE_S3_DESTINATION_DEFINITION_ID});
  const githubConfig=githubAppSettings(env.GITHUB_APP||null),github=githubConfig?createGitHubApp(githubConfig):null;
  // Source jobs reach the app here; it is rarely the browser origin.
  const proxyUrl=env.OPENCRAWL_AIRBYTE_APP_URL||settings.url;
  const connectorKey=()=>{const encoded=required('OPENCRAWL_CONNECTOR_KEY'),key=Buffer.from(encoded,'base64');if(key.length!==32||key.toString('base64')!==encoded)throw new Error('OPENCRAWL_CONNECTOR_KEY must be a base64-encoded 32-byte key');return key;};
  let oauth:ReturnType<typeof createSlackOAuth>|undefined;
  if(env.SLACK_CLIENT_ID||env.SLACK_CLIENT_SECRET){
    oauth=createSlackOAuth({organizationId:settings.organizationId,url:settings.url,proxyUrl,clientId:required('SLACK_CLIENT_ID'),clientSecret:required('SLACK_CLIENT_SECRET'),vault:credentialVault({state,prefix:'connector-credentials/v1',organizationId:settings.organizationId,key:connectorKey()}),registry});
    definitions.slack={name:'OpenCrawl Slack (operator OAuth)',manifest:slackOAuthManifest(connectorManifest('slack'))};
  }
  const disabled=async():Promise<never>=>{throw new Error('Configure operator-owned connector OAuth');};
  const unavailable:ConnectorOAuth={authConfig:disabled,link:disabled,account:disabled,remove:disabled,proxy:disabled,sourceConfiguration:disabled};
  // The operator's broker key comes from the server environment, or from an admin in the product.
  // An entered key is stored encrypted and takes effect without a restart.
  const managedKey=env.COMPOSIO_API_KEY||null;
  const saved=!managedKey&&env.OPENCRAWL_CONNECTOR_KEY?connectorSettingsStore({state,prefix:'connector-settings/v1',organizationId:settings.organizationId,key:connectorKey()}):null;
  const driveAudience=directory?workspaceDriveAudience(directory,settings.organizationId):undefined;
  const brokerFor=(apiKey:string)=>createComposioOAuth({apiKey,organizationId:settings.organizationId,proxyUrl,proxyKey:connectorKey(),registry,baseUrl:env.COMPOSIO_BASE_URL||undefined,driveAudience});
  let remembered:{at:number;apiKey:string|null}|undefined;
  let current:{apiKey:string;adapter:ReturnType<typeof brokerFor>}|undefined=managedKey?{apiKey:managedKey,adapter:brokerFor(managedKey)}:undefined;
  async function broker(){
    let apiKey=managedKey;
    if(!apiKey&&saved){
      // Another process may have saved a key; a short memory keeps catalog reads off storage.
      if(!remembered||Date.now()-remembered.at>15000)remembered={at:Date.now(),apiKey:(await saved.read()).record?.broker?.apiKey||null};
      apiKey=remembered.apiKey;
    }
    if(!apiKey){current=undefined;return undefined;}
    if(current?.apiKey!==apiKey)current={apiKey,adapter:brokerFor(apiKey)};
    return current.adapter;
  }
  // Existing grants retain their original adapter even if another is configured.
  const byGrant=async(id:string)=>/^grant_[a-f0-9]{48}$/.test(id)?oauth||unavailable:await broker()||unavailable;
  const authorization:ConnectorOAuth={
    recoverAuthConfig:async input=>(input.toolkit==='slack'&&oauth?oauth:await broker()||unavailable).recoverAuthConfig?.(input)??null,
    recoverLink:async input=>(input.authConfigId==='slack'?oauth||unavailable:await broker()||unavailable).recoverLink?.(input)??null,
    authConfig:async input=>(input.toolkit==='slack'&&oauth?oauth:await broker()||unavailable).authConfig(input),
    link:async input=>(input.authConfigId==='slack'?oauth||unavailable:await broker()||unavailable).link(input),
    account:async id=>(await byGrant(id)).account(id),remove:async id=>(await byGrant(id)).remove(id),
    proxy:async<T=ProviderData,>(input:ProxyRequest&{connectedAccountId:string;userId:string})=>(await byGrant(input.connectedAccountId)).proxy<T>(input),
    sourceConfiguration:async(record,provider)=>(await byGrant(record.connectedAccountId||'')).sourceConfiguration(record,provider),
  };
  const providers=createProviderCatalog(definitions,{driveWorkspaceAccess:true});
  const brokered=['googledrive','notion','circleback',...(!oauth?['slack']:[])].filter(id=>!providers[id]!.unavailableReason);
  const sentence=(names:string[])=>names.length>1?names.slice(0,-1).join(', ')+' and '+names.at(-1):names[0]||'';
  // Present when an admin can add the key in the product; otherwise the setup text names the server setting.
  const credential:ConnectorCredential|undefined=saved?{id:'composio',name:'Composio',label:'Composio API key',url:'https://dashboard.composio.dev/~/project/settings/api-keys',
    help:'Composio is a hosted service that signs people in to these tools and keeps their provider tokens. Create a project there and paste its API key. The key is stored encrypted on this instance and is never sent to source jobs.',
    unlocks:brokered.map(id=>providers[id]!.name)}:undefined;
  /** What still stands between each connector and its first sign-in. */
  async function pending(){
    const setup:Record<string,SourceSetup>={};
    if(!await broker())for(const id of brokered){
      const name=providers[id]!.name,ownSlack=id==='slack'?' You can instead configure your own Slack app with SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in the server configuration.':'';
      setup[id]={title:`Set up ${name}`,requirement:'Needs a Composio key',...(credential?{credential}:{}),body:credential
        ?`${name} signs in through Composio. Add your Composio API key once to enable ${sentence(credential.unlocks)}.${ownSlack}`
        :id==='slack'?'Your instance administrator can configure a Slack OAuth app with SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, or use an operator-owned Composio project with COMPOSIO_API_KEY. Restart the app after configuring it, then return here to connect Slack.'
        :'Your instance administrator can enable this connection with an operator-owned Composio project. Set COMPOSIO_API_KEY in the server configuration and restart the app. Then return here to authorize access to your account.'};
    }
    if(!github)setup.github={title:'Set up GitHub',requirement:'Needs a GitHub App',body:'Your instance administrator needs to configure a read-only GitHub App with GITHUB_APP and register the GitHub source image in Airbyte. The self-hosting guide in this repository lists the permissions and callback URL. Restart the app after configuring it, then return here to choose repositories.'};
    return setup;
  }
  // An operator has no other record of why Airbyte refused a connection.
  const log=(event:string,data:Record<string,unknown>)=>console.error(JSON.stringify({event,...data,...(typeof data.message==='string'?{message:data.message.slice(0,2000)}:{})}));
  const counts=createRecordCounts({buckets,legacyBucket:store.bucket,repository:countRepository});
  const realm=createRealm(settings.search);
  const barrier=(record:import('../integrations/types.mjs').IntegrationRecord)=>state.writeBarrier({namespace:'selfhost',tenantId:record.tenantId,connectionId:record.integrationId});
  const lifecycle={commands,resources,runProviderWrite:<T,>(record:import('../integrations/types.mjs').IntegrationRecord,operation:string,write:()=>Promise<T>)=>barrier(record).run('object-put',write,{target:operation}),schedule:(reference:IntegrationCommandReference)=>integrationLifecycleScheduler({...selfhostTemporalSettings(env),taskQueue:env.TEMPORAL_INTEGRATION_TASK_QUEUE||'integration-lifecycle-v1'})(reference),cleanup:{
    async closeWriters(record:import('../integrations/types.mjs').IntegrationRecord){await barrier(record).close();await counts.remove(record);},
    async stopWriters(record:import('../integrations/types.mjs').IntegrationRecord){
      const scheduling=await connectorClient(selfhostTemporalSettings(env));
      try {
        const ids=['connector-'+digest([record.tenantId,record.integrationId,'v1'])];
        if(record.provider==='slack')ids.push(...['slack-files-','slack-messages-'].map(prefix=>prefix+digest([record.tenantId,record.integrationId])));
        for(const id of ids)try{await scheduling.client.schedule.getHandle(id).delete();}catch(error){if(errorInfo(error).name!=='ScheduleNotFoundError')throw error;}
      } finally {await scheduling.connection.close();}
    },
    async drainWriters(record:import('../integrations/types.mjs').IntegrationRecord){
      const writers=await barrier(record).inspect();
      if(!writers.closed||writers.pending)throw Object.assign(new Error('Waiting for positive native writer settlement'),{code:'CONNECTOR_WRITE_PENDING'});
      await drainProofs.requireProof(record);
    },
    async deleteDocuments(record:import('../integrations/types.mjs').IntegrationRecord){
      if(record.tenantId!==settings.organizationId)throw Object.assign(new Error('Cleanup scope denied'),{permanent:true});
      const result=await realm.collection('connector').byQuery({tenantId:settings.organizationId},'delete',{term:{'connector.connectionId':record.integrationId}});return result.changed;
    },
  }};
  const product=createIntegrations({environment:'selfhost',appUrl:settings.url,registry,buckets,legacyBucket:store.bucket,workspaceId:async()=>workspaceId,destination,airbyte,oauth:authorization,providers,github,log,lifecycle,counts});
  const integrations:ReturnType<typeof createIntegrations>={...product,
    async list(principal){const setup=await pending();return (await product.list(principal)).map(card=>setup[card.provider]?{...card,state:'setup-required' as const,setup:setup[card.provider]}:card);},
    async connect(principal,id,input){const setup=(await pending())[id];if(setup)throw Object.assign(new Error(setup.body),{status:503,expose:true});return product.connect(principal,id,input);},
  };
  const refused=(status:number,message:string)=>Object.assign(new Error(message),{status,expose:true});
  const connectorSettings={
    /** Stores the broker key once its service accepts it. The caller has already admitted an admin. */
    async save(id:string,value:unknown,by:{userId:string}){
      if(id!=='composio')throw refused(404,'Unknown connector credential.');
      if(managedKey)throw refused(409,'This key is set in the server environment. Change it there and restart the app.');
      if(!saved)throw refused(409,'Set OPENCRAWL_CONNECTOR_KEY in the server configuration before saving connector credentials.');
      const apiKey=typeof value==='string'?value.trim():'';
      if(!/^[\x21-\x7e]{8,512}$/.test(apiKey))throw refused(400,'That doesn’t look like a Composio API key.');
      try{await brokerFor(apiKey).verify();}
      catch(error){throw [401,403].includes(errorInfo(error).status||0)?refused(400,'Composio did not accept that key. Copy the API key from your Composio project and try again.'):refused(503,'We couldn’t reach Composio to check that key. Try again.');}
      await saved.write({version:1,organizationId:settings.organizationId,broker:{apiKey,savedAt:new Date().toISOString(),savedBy:by.userId}},(await saved.read()).version);
      remembered={at:Date.now(),apiKey};
    },
  };
  const baseConnectors=createConnectorResolver({environment:'selfhost',generation:'v1',registry,state,
    ...(driveAudience?{driveAccess:(record:import('../integrations/types.mjs').IntegrationRecord)=>createDriveAccess({audience:driveAudience,request:input=>authorization.proxy({...input,connectedAccountId:record.connectedAccountId||'',userId:`selfhost:${record.tenantId}:${record.userId}`})})}:{}),
    async storage(record){destination.validate(record);return store;},search:tenantId=>{if(tenantId!==settings.organizationId)throw new Error('Workspace scope denied');return createConnectorSearch(settings.search);}});
  const connectors={...baseConnectors,async resolve(input:Parameters<typeof baseConnectors.resolve>[0]){
    const resolved=await baseConnectors.resolve(input);
    const guarded=guardConnectorWrites({state,binding:resolved.binding,store:resolved.store,search:resolved.search});
    return {...resolved,...guarded,async afterObject(key:string,check:()=>void){
      check();await baseConnectors.resolve(input);
      const record=await registry.get(input.tenantId as string,input.userId as string,input.connectionId as string);
      if(!record||record.status!=='active')throw Object.assign(new Error('Measurement connection is inactive'),{permanent:true});
      const jobs=await airbyte.jobs(record.airbyte?.connectionId||'',100);
      await counts.refresh(record,providers[record.provider]!,new Set(jobs.filter(job=>job.status==='succeeded').map(job=>Number(job.jobId))),{key,check});
    }};
  }};
  const validateReference=(reference:IntegrationCommandReference)=>{
    if(reference.environment!=='selfhost'||reference.tenantId!==settings.organizationId)throw Object.assign(new Error('Integration workflow scope denied'),{permanent:true});
  };
  const lifecycleActivities={
    async resolve(reference:IntegrationCommandReference){
      validateReference(reference);
      return {commands,runner:{step:product.lifecycleStep},async authorize(command:IntegrationCommand){
        if(!directory)throw new Error('Current integration authorization directory is unavailable');
        const record=await registry.get(reference.tenantId,reference.userId,reference.integrationId);
        const memberships=await activeMemberships(directory,command.requestedBy,reference.tenantId);
        if(!record||memberships.length!==1||(record.scope==='team'?!isAdmin(memberships[0]):record.userId!==command.requestedBy))throw Object.assign(new Error('Integration permission revoked'),{status:403});
      }};
    },
    async resolveRecovery({sourceId}:{sourceId:string}){
      if(sourceId!==integrationSourceId)throw Object.assign(new Error('Integration recovery scope denied'),{permanent:true});return commands;
    },
    async reconcileSchedules({sourceId}:{sourceId:string}){
      if(sourceId!==integrationSourceId)throw Object.assign(new Error('Integration scheduling scope denied'),{permanent:true});
      const scheduling=await connectorClient(selfhostTemporalSettings(env)),failures:unknown[]=[];
      try {
        for(const record of (await registry.listTenant(settings.organizationId)).filter(record=>record.status==='active'&&eligible(record))){
          const reference={tenantId:record.tenantId,userId:record.userId,connectionId:record.integrationId,generation:'v1'};
          try {await connectors.resolve(reference);await barrier(record).run('object-put',()=>ensureConnectorSchedule(scheduling.client,{reference,taskQueue:env.TEMPORAL_CONNECTOR_TASK_QUEUE||'connector-indexing-v1',generation:'v1'}),{target:'temporal-indexing-schedule'});}
          catch(error){failures.push(error);}
        }
        if(failures.length)throw new Error('Some active integration schedules could not be reconciled');
      } finally {await scheduling.connection.close();}
    },
  };
  // Compatibility callers can explicitly resubmit pending commands. Supported
  // runtimes use Temporal recovery; API startup does not start background work.
  async function recover(){for(const record of await registry.listTenant(settings.organizationId))await integrations.recoverRecord(record);}
  // One proxy route serves every adapter; a capability is only valid at the adapter that issued it.
  const denied=async():Promise<never>=>{throw Object.assign(new Error('Connector authorization unavailable'),{status:403});};
  const sourceCredentials:SourceCredentialProxy={proxyCredential:async(id:string,secret:string,userId:string,input:ProxyRequest)=>
    /^grant_[a-f0-9]{48}$/.test(id)?oauth?oauth.proxyCredential(id,secret,userId,input):denied():(await broker())?.proxyCredential(id,secret,userId,input)??denied()};
  return {registry,commands,ready,integrations,providers,connectors,oauth,sourceCredentials,connectorSettings,integrationSourceId,lifecycleActivities,countRepository,drainProofs,recover,close:registry.close};
}
