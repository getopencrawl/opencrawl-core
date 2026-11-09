import type {IncomingMessage,ServerResponse} from 'node:http';
import type {createSlackOAuth} from './slack-oauth.mjs';
import {smallJson} from '../application/http.mjs';
import {errorInfo} from '../errors.mjs';
/** Airbyte has one revocable source capability, never an OAuth client or workspace-wide proxy key. */
export function connectorProxyHandler(oauth:Pick<ReturnType<typeof createSlackOAuth>,'proxyCredential'>){
  return async(req:IncomingMessage,res:ServerResponse)=>{
    res.setHeader('Cache-Control','no-store');
    const reply=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
    if(req.headers.origin)return reply(403,{error:'BROWSER_REQUEST_DENIED'});
    try{
      const secret=req.headers['x-api-key'];if(typeof secret!=='string'||secret.length>256)return reply(401,{error:'SOURCE_CREDENTIAL_REQUIRED'});
      const input=await smallJson(req,65536);
      if(Object.keys(input).some(k=>!['connected_account_id','user_id','method','endpoint','parameters','body'].includes(k))||typeof input.connected_account_id!=='string'||typeof input.user_id!=='string'||typeof input.endpoint!=='string'||input.method!==undefined&&input.method!=='GET'||input.parameters!==undefined&&!Array.isArray(input.parameters))return reply(400,{error:'INVALID_REQUEST'});
      const query:Record<string,string>={},headers:Record<string,string>={};
      for(const item of (input.parameters||[]) as unknown[]){
        if(!item||typeof item!=='object'||!('name'in item)||typeof item.name!=='string'||!('value'in item)||!['string','number','boolean'].includes(typeof item.value)||!('type'in item)||!['query','header'].includes(String(item.type)))return reply(400,{error:'INVALID_PARAMETER'});
        const target=item.type==='query'?query:headers;if(Object.hasOwn(target,item.name))return reply(400,{error:'DUPLICATE_PARAMETER'});target[item.name]=String(item.value);
      }
      const result=await oauth.proxyCredential(input.connected_account_id,secret,input.user_id,{endpoint:input.endpoint,method:input.method as string|undefined,query,headers,body:input.body});
      return reply(200,result);
    }catch(error){return reply([400,401,403,404,409].includes(errorInfo(error).status||0)?errorInfo(error).status!:503,{error:'SOURCE_PROXY_UNAVAILABLE'});}
  };
}
