import type {ConnectorOAuth} from './ports.mjs';
import type {ProxyRequest,ProxyResponse,ProviderData} from './types.mjs';

interface Options {apiKey:string;organizationId:string;fetch?:typeof globalThis.fetch}
interface AuthConfig {id:string;name:string;toolkit?:{slug:string};status:string;is_composio_managed:boolean;auth_scheme?:string}
interface Account {id:string;user_id?:string;status:string;is_disabled?:boolean;toolkit?:{slug:string}}
/** Optional operator-owned OAuth broker. Core does not require a managed account. */
export function createComposioOAuth({apiKey,organizationId,fetch:send=globalThis.fetch}:Options):ConnectorOAuth {
  if(!apiKey||!/^org_[A-Za-z0-9]+$/.test(organizationId))throw new Error('Configure an operator-owned Composio project and organization');
  const baseUrl='https://backend.composio.dev';
  const owner=(userId:string)=>{if(!userId.startsWith(`selfhost:${organizationId}:`)||!/^selfhost:org_[A-Za-z0-9]+:user_[A-Za-z0-9]+$/.test(userId))throw new Error('Connector scope denied');return userId;};
  async function request<T>(method:string,path:string,body?:unknown):Promise<T>{
    const response=await send(baseUrl+'/api/v3.1'+path,{method,headers:{'x-api-key':apiKey,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Object.assign(new Error(`Connector authorization service returned ${response.status}`),{status:response.status});
    const text=await response.text();return text?JSON.parse(text) as T:undefined as T;
  }
  return {
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
    proxy:<T=ProviderData,>({connectedAccountId,userId,endpoint,method='GET',query={},headers={},body}:ProxyRequest&{connectedAccountId:string;userId:string})=>request<ProxyResponse<T>>('POST','/tools/execute/proxy',{
      connected_account_id:connectedAccountId,user_id:owner(userId),endpoint,method,...(body===undefined?{}:{body}),
      parameters:[...Object.entries(query).filter(([,v])=>v!==undefined).map(([name,value])=>({name,value:String(value),type:'query'})),...Object.entries(headers).map(([name,value])=>({name,value:String(value),type:'header'}))],
    }),
    async sourceConfiguration(record,provider){
      if(record.tenantId!==organizationId||record.environment!=='selfhost')throw new Error('Connector scope denied');
      return {composio_api_key:apiKey,composio_base_url:baseUrl,connected_account_id:record.connectedAccountId,
        user_id:owner(`selfhost:${record.tenantId}:${record.userId}`),...provider.sourceConfiguration({startDate:record.startDate,record})};
    },
  };
}
