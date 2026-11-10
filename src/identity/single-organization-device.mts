import type {IncomingMessage,ServerResponse} from 'node:http';
import type {IdentitySettings} from './types.mjs';
import type {WorkOS as Workos} from '@workos-inc/node';
import {activeMemberships} from './principal.mjs';
import {currentVerifiedUser} from './auth.mjs';
/** WorkOS device sign-in may inherit a different organization from AuthKit.
 * Exchange into the operator's fixed organization; never reinterpret foreign JWT claims.
 * The portable CLI still speaks ordinary OAuth to a deployment-advertised endpoint.
 */
export function singleOrganizationDevice(settings:IdentitySettings & {organizationId:string},workos:Workos,send:typeof fetch=fetch){
 const errors=new Set(['authorization_pending','slow_down','access_denied','expired_token','invalid_grant']);
 return async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Pragma','no-cache');
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(req.method!=='POST')return reply(405,{error:'invalid_request'});
  if(req.headers.origin)return reply(403,{error:'access_denied'});
  if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')return reply(415,{error:'invalid_request'});
  let bytes=0;const chunks:Buffer[]=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>32768)return reply(413,{error:'invalid_request'});chunks.push(Buffer.from(chunk));}
  const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),grant=form.get('grant_type');
  const field=grant==='refresh_token'?'refresh_token':grant==='urn:ietf:params:oauth:grant-type:device_code'?'device_code':null;
  if(!field||form.get('client_id')!==settings.clientId||[...form.keys()].some(key=>!['client_id','grant_type',field].includes(key)||form.getAll(key).length!==1)
    ||!form.get(field)||form.get(field)!.length>16384)return reply(400,{error:'invalid_request'});
  try{
   let refreshToken=form.get(field)!;
   if(field==='device_code'){
    const response=await send('https://api.workos.com/user_management/authenticate',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form,redirect:'error',signal:AbortSignal.timeout(15000)});
    const body=await response.json() as {error?:string;refresh_token?:string};
    if(!response.ok)return reply(response.status===429?400:response.status>=500?503:400,{error:response.status===429?'slow_down':errors.has(body.error||'')?body.error:response.status>=500?'temporarily_unavailable':'access_denied'});
    if(typeof body.refresh_token!=='string'||!body.refresh_token)return reply(503,{error:'temporarily_unavailable'});
    refreshToken=body.refresh_token;
   }
   // WorkOS applies the target organization's SSO/MFA/membership policy here.
   const scoped=await workos.userManagement.authenticateWithRefreshToken({clientId:settings.clientId,refreshToken,organizationId:settings.organizationId});
   if(scoped.organizationId!==settings.organizationId||!scoped.user?.id)return reply(403,{error:'access_denied'});
   const current=await currentVerifiedUser(workos,scoped.user.id);
   if(current.status!==200)return reply(current.status===503?503:403,{error:current.status===503?'temporarily_unavailable':'access_denied'});
   if((await activeMemberships(workos,scoped.user.id,settings.organizationId)).length!==1)return reply(403,{error:'access_denied'});
   return reply(200,{access_token:scoped.accessToken,refresh_token:scoped.refreshToken,token_type:'Bearer'});
  }catch(error){const value=error as {status?:number;error?:string};return reply(value.status&&value.status<500?400:503,{error:errors.has(value.error||'')?value.error:value.status&&value.status<500?'access_denied':'temporarily_unavailable'});}
 };
}
