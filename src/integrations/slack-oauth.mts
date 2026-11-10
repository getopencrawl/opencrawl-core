import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {ConnectorOAuth,IntegrationRegistry} from './ports.mjs';
import type {ProxyRequest,ProxyResponse,ProviderData} from './types.mjs';
import type {Principal} from '../identity/types.mjs';
import type {credentialVault,ConnectorGrant} from './credential-vault.mjs';
import {slackPublicRead} from './slack-proxy-policy.mjs';
const SCOPES=['channels:read','channels:history','search:read','users:read','team:read','emoji:read'];
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const fail=(status:number,message='Connector authorization unavailable'):never=>{throw Object.assign(new Error(message),{status});};
interface TokenResponse {ok?:boolean;error?:string;access_token?:string;refresh_token?:string;expires_in?:number;token_type?:string;scope?:string;authed_user?:TokenResponse}
interface Options {organizationId:string;url:string;proxyUrl:string;clientId:string;clientSecret:string;vault:ReturnType<typeof credentialVault>;registry:IntegrationRegistry;fetch?:typeof globalThis.fetch;now?:()=>number}
/** Operator-owned Slack app. No OpenCrawl service or managed credential account. */
export function createSlackOAuth({organizationId,url,proxyUrl,clientId,clientSecret,vault,registry,fetch:send=globalThis.fetch,now=Date.now}:Options){
  if(!clientId||!clientSecret||new URL(url).protocol!=='https:'||!['https:','http:'].includes(new URL(proxyUrl).protocol))throw new Error('Configure Slack OAuth and the Airbyte-accessible app URL');
  const redirectUri=url+'/oauth/connectors/slack/callback';
  const userKey=(userId:string)=>`selfhost:${organizationId}:${userId}`;
  const load=async(id:string)=>{const saved=await vault.read(id);if(!saved.record)fail(404);return {...saved,record:saved.record!};};
  async function token(fields:Record<string,string>){
    const response=await send('https://slack.com/api/oauth.v2.access',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,...fields}),redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)fail(503);
    const body=await response.json() as TokenResponse;
    if(body.ok!==true)fail(503);
    const t=body.authed_user||body;
    if(t.token_type!=='user'||typeof t.access_token!=='string'||!t.access_token||!SCOPES.every(s=>(t.scope||'').split(',').includes(s)))fail(503);
    if(t.expires_in!==undefined&&(!Number.isSafeInteger(t.expires_in)||t.expires_in<60||!t.refresh_token))fail(503);
    return {accessToken:t.access_token,refreshToken:t.refresh_token,accessExpiresAt:t.expires_in?now()+t.expires_in*1000:undefined};
  }
  async function active(id:string){
    const saved=await load(id),g=saved.record;
    if(g.status!=='ACTIVE'||!g.accessToken)fail(403);
    if(g.accessExpiresAt!==undefined&&g.accessExpiresAt<now()+60000){
      if(!g.refreshToken)fail(403);
      // Persist the claim before the one-shot provider exchange. A lost response
      // requires reconnection, never a guessed retry with a consumed refresh token.
      await vault.write({...g,status:'REFRESHING'},saved.version);
      const refreshed=await token({grant_type:'refresh_token',refresh_token:g.refreshToken!});
      const latest=await load(id);if(latest.record.status!=='REFRESHING')fail(403);
      const next={...latest.record,...refreshed,status:'ACTIVE' as const};await vault.write(next,latest.version);return next;
    }
    return g;
  }
  async function binding(g:ConnectorGrant){
    const record=await registry.get(organizationId,g.userId,g.integrationId);
    if(!record||record.provider!=='slack'||record.connectedAccountId!==g.id||!['connecting','provisioning','active','error'].includes(record.status))fail(403);
    return record;
  }
  const proxy=async<T=ProviderData,>({connectedAccountId,userId,...request}:ProxyRequest&{connectedAccountId:string;userId:string}):Promise<ProxyResponse<T>>=>{
    const g=await active(connectedAccountId);if(userId!==userKey(g.userId))fail(403);await binding(g);
    const result=await slackPublicRead<T>(request,async target=>{
      const response=await send(target,{headers:{Authorization:'Bearer '+g.accessToken},redirect:'error',signal:AbortSignal.timeout(30000)});
      const retry=response.headers.get('retry-after'),replyHeaders:Record<string,string>=retry===null?{}:{'retry-after':retry};
      return {ok:response.ok,status:response.status,data:await response.json(),headers:replyHeaders};
    });
    const current=await load(g.id);if(current.record.status!=='ACTIVE')fail(403);await binding(current.record);
    return result;
  };
  const service:ConnectorOAuth={
    async authConfig({toolkit}){if(toolkit!=='slack')fail(404);return 'slack';},
    async link({authConfigId,userId,callbackUrl}){
      if(authConfigId!=='slack'||!userId.startsWith(`selfhost:${organizationId}:`))fail(403);
      const owner=userId.slice(`selfhost:${organizationId}:`.length),callback=new URL(callbackUrl);
      if(!/^user_[A-Za-z0-9]+$/.test(owner)||callback.origin!==url||callback.pathname!=='/integrations/slack/callback')fail(403);
      const integrationId=callback.searchParams.get('integration')||'';if(!/^int_[a-f0-9]{26}$/.test(integrationId))fail(400);
      const id='grant_'+randomBytes(24).toString('hex'),state=randomBytes(32).toString('base64url');
      const record:ConnectorGrant={version:1,id,organizationId,userId:owner,integrationId,provider:'slack',status:'INITIATED',callbackUrl,flowExpiresAt:now()+600000,state,proxyToken:randomBytes(32).toString('base64url')};
      await vault.write(record,null);
      const authorize=new URL('https://slack.com/oauth/v2/authorize');authorize.search=new URLSearchParams({client_id:clientId,user_scope:SCOPES.join(','),redirect_uri:redirectUri,state:id+'.'+state}).toString();
      return {redirect_url:authorize.href,connected_account_id:id,expires_at:new Date(record.flowExpiresAt).toISOString()};
    },
    async account(id){const {record:g}=await load(id);return {id:g.id,user_id:userKey(g.userId),status:g.status==='REFRESHING'?'EXPIRED':g.status==='EXCHANGING'?'INITIALIZING':g.status,toolkit:{slug:'slack'}};},
    async remove(id){
      const saved=await load(id),g=saved.record;
      if(g.status!=='REVOKED')await vault.write({...g,status:'REVOKED'},saved.version);
      if(g.accessToken&&!g.remoteRevoked){
        const response=await send('https://slack.com/api/auth.revoke',{headers:{Authorization:'Bearer '+g.accessToken},redirect:'error',signal:AbortSignal.timeout(30000)});
        const body=await response.json() as {ok?:boolean;error?:string};if(!response.ok||body.ok!==true&&!['invalid_auth','token_revoked'].includes(body.error||''))fail(503);
        const latest=await load(id);await vault.write({...latest.record,accessToken:undefined,refreshToken:undefined,remoteRevoked:true},latest.version);
      }
    },proxy,
    async sourceConfiguration(record,provider){const g=await active(record.connectedAccountId||'');if(g.integrationId!==record.integrationId||g.userId!==record.userId||record.tenantId!==organizationId)fail(403);return {...provider.sourceConfiguration({startDate:record.startDate,record}),credential_proxy_base_url:proxyUrl,credential_proxy_api_key:g.proxyToken,connected_account_id:g.id,user_id:userKey(g.userId)};},
  };
  return {...service,
    /** Browser session must be admitted before passing its principal to this callback. */
    async complete(principal:Principal,query:URLSearchParams){
      const [id,state,...extra]=(query.get('state')||'').split('.');if(!id||!state||extra.length)fail(400);
      const saved=await load(id),g=saved.record;
      if(principal.tenantId!==organizationId||principal.userId!==g.userId||!equal(g.state,state)||g.flowExpiresAt<=now()||g.status!=='INITIATED')fail(403);
      await binding(g);
      if(query.has('error')){await vault.write({...g,status:'FAILED'},saved.version);const target=new URL(g.callbackUrl);target.searchParams.set('status','failed');return target.href;}
      const code=query.get('code');if(!code||code.length>4096)fail(400);
      await vault.write({...g,status:'EXCHANGING'},saved.version);
      const grant=await token({code:code!,redirect_uri:redirectUri});
      const latest=await load(id);if(latest.record.status!=='EXCHANGING')fail(403);
      await vault.write({...latest.record,...grant,status:'ACTIVE'},latest.version);
      return g.callbackUrl;
    },
    async proxyCredential(id:string,secret:string,userId:string,input:ProxyRequest){
      const {record:g}=await load(id);if(!equal(g.proxyToken,secret)||userKey(g.userId)!==userId)fail(403);
      return proxy({...input,connectedAccountId:id,userId});
    },
  };
}
