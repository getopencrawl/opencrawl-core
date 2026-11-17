import {createHmac,timingSafeEqual} from 'node:crypto';
import type {ConnectorOAuth,IntegrationRegistry} from './ports.mjs';
import type {ProxyRequest,ProxyResponse,ProviderData} from './types.mjs';
import {slackPublicRead} from './slack-proxy-policy.mjs';
import {createGoogleDriveSource} from './google-drive-source.mjs';
import type {DriveAudience} from './google-drive-access.mjs';

interface Options {
  apiKey:string;organizationId:string;
  /** App address that source jobs can reach, and the secret that derives each source's capability. */
  proxyUrl:string;proxyKey:Uint8Array;registry:Pick<IntegrationRegistry,'list'>;
  baseUrl?:string;fetch?:typeof globalThis.fetch;
  driveAudience?:DriveAudience;
}
interface AuthConfig {id:string;name:string;toolkit?:{slug:string};status:string;is_composio_managed:boolean;auth_scheme?:string}
interface Account {id:string;user_id?:string;status:string;is_disabled?:boolean;toolkit?:{slug:string}}
const fail=(status:number,message='Connector authorization unavailable'):never=>{throw Object.assign(new Error(message),{status});};
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const BOUND=['connecting','provisioning','active','error'];
/** Everything a source capability may read. Paths mirror the published connector manifests. */
const READS:Record<string,{headers:string[];routes:Array<[method:string,endpoint:RegExp]>}>={
  notion:{headers:['notion-version'],routes:[['POST',/^https:\/\/api\.notion\.com\/v1\/search$/],['GET',/^https:\/\/api\.notion\.com\/v1\/(?:pages\/[A-Za-z0-9-]+\/markdown|comments|users)$/]]},
  circleback:{headers:[],routes:[['GET',/^https:\/\/circleback\.ai\/api\/(?:meetings|meeting\/[A-Za-z0-9_-]+\/transcript)$/]]},
};
/**
 * Optional operator-owned OAuth broker. Core does not require a managed account.
 * The project key stays in this process: a source job receives only a capability for its own
 * connection and reads through the app's credential proxy.
 */
export function createComposioOAuth({apiKey,organizationId,proxyUrl,proxyKey,registry,baseUrl='https://backend.composio.dev',fetch:send=globalThis.fetch,driveAudience}:Options){
  if(!apiKey||!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure an operator-owned Composio project and organization');
  if(proxyKey.length!==32||!['https:','http:'].includes(new URL(proxyUrl).protocol))throw new Error('Configure the connector key and the Airbyte-accessible app URL');
  const service=new URL(baseUrl);
  if(!['https:','http:'].includes(service.protocol)||service.origin!==baseUrl.replace(/\/$/,'')||service.username||service.password)throw new Error('Configure the Composio API origin');
  const scope=`selfhost:${organizationId}:`;
  const owner=(userId:string)=>{if(!userId.startsWith(scope)||!/^selfhost:org_[A-Za-z0-9]+:user_[A-Za-z0-9]+$/.test(userId))fail(403,'Connector scope denied');return userId;};
  const capability=(connectedAccountId:string,userId:string)=>createHmac('sha256',proxyKey).update(['opencrawl-source-capability-v1',organizationId,connectedAccountId,userId].join('\n')).digest('base64url');
  async function request<T>(method:string,path:string,body?:unknown):Promise<T>{
    const response=await send(service.origin+'/api/v3.1'+path,{method,headers:{'x-api-key':apiKey,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Object.assign(new Error(`Connector authorization service returned ${response.status}`),{status:response.status});
    const text=await response.text();return text?JSON.parse(text) as T:undefined as T;
  }
  const proxy=<T=ProviderData,>({connectedAccountId,userId,endpoint,method='GET',query={},headers={},body}:ProxyRequest&{connectedAccountId:string;userId:string})=>request<ProxyResponse<T>>('POST','/tools/execute/proxy',{
    connected_account_id:connectedAccountId,user_id:owner(userId),endpoint,method,...(body===undefined?{}:{body}),
    parameters:[...Object.entries(query).filter(([,v])=>v!==undefined).map(([name,value])=>({name,value:String(value),type:'query'})),...Object.entries(headers).map(([name,value])=>({name,value:String(value),type:'header'}))],
  });
  /** The live connection this capability was issued for; disconnecting ends it. */
  const bound=async(connectedAccountId:string,userId:string)=>(await registry.list(organizationId,userId.slice(scope.length)))
    .find(record=>record.connectedAccountId===connectedAccountId&&record.environment==='selfhost'&&BOUND.includes(record.status))||fail(403);
  const oauth:ConnectorOAuth={
    async authConfig({toolkit,name,scheme,credentials={}}){
      const {items=[]}=await request<{items?:AuthConfig[]}>('GET',`/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}&limit=100`);
      const existing=items.find(c=>c.name===name&&c.toolkit?.slug===toolkit&&c.status==='ENABLED'&&(scheme?!c.is_composio_managed&&c.auth_scheme===scheme:c.is_composio_managed));
      if(existing)return existing.id;
      const created=await request<{auth_config:{id:string}}>('POST','/auth_configs',{toolkit:{slug:toolkit},auth_config:scheme
        ?{type:'use_custom_auth',authScheme:scheme,name,credentials}:{type:'use_composio_managed_auth',name,credentials}});
      return created.auth_config.id;
    },
    link:({authConfigId,userId,callbackUrl})=>request('POST','/connected_accounts/link',{auth_config_id:authConfigId,user_id:owner(userId),callback_url:callbackUrl}),
    account:async id=>{
      const account=await request<Account>('GET',`/connected_accounts/${encodeURIComponent(id)}`);
      owner(account.user_id||'');return account;
    },
    async remove(id){const account=await request<Account>('GET',`/connected_accounts/${encodeURIComponent(id)}`);owner(account.user_id||'');await request('DELETE',`/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`);},
    proxy,
    async sourceConfiguration(record,provider){
      if(record.tenantId!==organizationId||record.environment!=='selfhost'||!record.connectedAccountId)fail(403,'Connector scope denied');
      const userId=owner(scope+record.userId);
      return {...provider.sourceConfiguration({startDate:record.startDate,record}),credential_proxy_base_url:proxyUrl,
        credential_proxy_api_key:capability(record.connectedAccountId!,userId),connected_account_id:record.connectedAccountId,user_id:userId};
    },
  };
  return {...oauth,
    /** Confirms the project accepts this key before anything depends on it. */
    async verify(){await request('GET','/auth_configs?limit=1');},
    /** One source's read through its capability. The caller is a source job, never a browser. */
    async proxyCredential(id:string,secret:string,userId:string,{endpoint,method='GET',query={},headers={},body}:ProxyRequest):Promise<ProxyResponse<unknown>>{
      if(!id||!equal(capability(id,owner(userId)),secret))fail(403);
      const record=await bound(id,userId);
      let result:ProxyResponse<unknown>;
      if(record.provider==='googledrive'){
        if(!driveAudience)fail(503,'Drive workspace membership is unavailable');
        result=await createGoogleDriveSource({tenantId:organizationId,connectionId:record.integrationId,audience:driveAudience!,fetch:send,
          request:input=>proxy({...input,connectedAccountId:id,userId})}).read({endpoint,method,query,headers,body});
      }else if(record.provider==='slack'){
        result=await slackPublicRead({endpoint,method,query,headers,body},async target=>{
          const reply=await proxy({connectedAccountId:id,userId,endpoint:target.origin+target.pathname,query:Object.fromEntries(target.searchParams)});
          return {ok:reply.status>=200&&reply.status<300,status:reply.status,data:reply.data,headers:reply.headers};
        });
      }else{
        const reads=READS[record.provider]||fail(403);
        let target:URL;try{target=new URL(endpoint);}catch{return fail(403);}
        if(target.username||target.password||target.hash||target.search||!reads.routes.some(([allowed,pattern])=>allowed===method&&pattern.test(target.href)))fail(403);
        if(method==='GET'&&body!==undefined||Object.keys(headers).some(name=>!reads.headers.includes(name.toLowerCase())))fail(403);
        result=await proxy({connectedAccountId:id,userId,endpoint:target.href,method,query,headers,body});
      }
      await bound(id,userId);
      return result;
    },
  };
}
