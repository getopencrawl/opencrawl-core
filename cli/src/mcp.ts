import {StreamableHTTPClientTransport, isJSONRPCRequest, isJSONRPCResponse, type JSONRPCMessage, type RequestId, type Transport, type FetchLike} from '@modelcontextprotocol/client';
import {StdioServerTransport} from '@modelcontextprotocol/server/stdio';
import {parseArgs} from 'node:util';
import {apiOrigin, CliError, DEFAULT_API_ORIGIN} from './oauth.ts';
import {configuredToken, workspaceIdentityEnabled} from './workspace-identity.ts';
import {accessToken,readSession} from './session.ts';
import {withEnvironmentTokenOrigin} from './environment-token.ts';
import {readCaptureConfig} from './capture/runtime.ts';
import {hasPluginContext,pluginHookContext} from './setup/plugin-context.ts';

/** Authentication is renewed per HTTP exchange, not copied into a long-lived
 * MCP configuration. Redirects never receive credentials or request bodies. */
export function authenticatedMcpFetch(api:string,{fetcher=fetch,validateBinding=()=>{},credential=async(rejected?:string,signal?:AbortSignal)=>{
  const configured=await configuredToken('OPENCRAWL_TOKEN',api,rejected,signal);
  return {token:configured||await accessToken(api,rejected,fetcher),refreshable:!configured||workspaceIdentityEnabled()};
}}:{fetcher?:typeof fetch;validateBinding?:()=>void;credential?:(rejected?:string,signal?:AbortSignal)=>Promise<{token:string;refreshable:boolean}>}={}):FetchLike {
  const endpoint=apiOrigin(api)+'/mcp';
  return async(url,init={})=>{
    if(String(url)!==endpoint)throw new CliError('TOKEN_DESTINATION_MISMATCH','MCP attempted to use a different endpoint.',64);
    validateBinding();
    const signal=init.signal??undefined;
    signal?.throwIfAborted();
    let auth=await credential(undefined,signal);
    const send=async()=>{
      signal?.throwIfAborted();
      validateBinding();
      const headers=new Headers(init.headers);headers.set('authorization','Bearer '+auth.token);
      const response=await fetcher(endpoint,{...init,headers,redirect:'error'});
      try{validateBinding();}catch(error){await response.body?.cancel();throw error;}
      if(response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('MCP redirect refused');}
      return response;
    };
    let response=await send();
    if(response.status===401&&auth.refreshable){
      await response.body?.cancel();
      auth=await credential(auth.token,signal);
      response=await send();
    }
    return response;
  };
}

/** The official SDK transports retain the server's tool definitions, results,
 * errors and protocol metadata. There is no second tool catalogue or API shim.
 * Only authentication and stdio/HTTP lifetime differ at this boundary. */
export async function bridgeMcp({input,remote,signal,timeoutMs=70000,maxPending=32}: {
  input:Transport;remote:StreamableHTTPClientTransport;signal?:AbortSignal;timeoutMs?:number;maxPending?:number;
}):Promise<void> {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||!Number.isInteger(maxPending)||maxPending<1||maxPending>128)throw Error('Invalid MCP bridge limits');
  const pending=new Map<RequestId,{controller:AbortController;timer:ReturnType<typeof setTimeout>;method:string}>();
  let closed=false,notifications=0,outputBytes=0,finish!:()=>void;
  const done=new Promise<void>(resolve=>{finish=resolve;});
  function retire(id:RequestId){const item=pending.get(id);if(item){clearTimeout(item.timer);pending.delete(id);}return item;}
  async function close(){
    if(closed)return;closed=true;
    for(const [id] of pending)retire(id)?.controller.abort();
    try{await Promise.allSettled([input.close(),remote.close()]);}finally{finish();}
  }
  function output(message:JSONRPCMessage){
    if(closed)return;
    const bytes=Buffer.byteLength(JSON.stringify(message));
    if(outputBytes+bytes>8*1024*1024){void close();return;}
    outputBytes+=bytes;
    void input.send(message).catch(()=>close()).finally(()=>{outputBytes-=bytes;});
  }
  function fail(id:RequestId,message='OpenCrawl MCP request failed. Retry after checking the connection.'){
    const item=retire(id);if(!item)return;item.controller.abort();
    output({jsonrpc:'2.0',id,error:{code:-32603,message}});
  }
  remote.onmessage=message=>{
    if(isJSONRPCResponse(message)&&message.id!==undefined){
      const item=retire(message.id);
      if(!item)return; // A cancelled/timed-out request cannot deliver a late result.
      if(item.method==='initialize'&&'result' in message&&typeof message.result.protocolVersion==='string')remote.setProtocolVersion(message.result.protocolVersion);
    }
    output(message);
  };
  // Per-request failures are handled by send/stream-end. The SDK may also report
  // a legacy optional GET stream failure; it must not expose server error text.
  remote.onerror=()=>{};
  remote.onclose=()=>{void close();};
  input.onclose=()=>{void close();};
  input.onerror=()=>{void close();};
  input.onmessage=message=>{
    if(closed)return;
    if('method' in message&&message.method==='notifications/cancelled'){
      const id=message.params?.requestId;
      if(typeof id==='string'||typeof id==='number')retire(id)?.controller.abort();
    }
    if(isJSONRPCRequest(message)){
      if(pending.has(message.id)){void close();return;}
      if(pending.size>=maxPending){output({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Too many concurrent OpenCrawl requests. Retry when another finishes.'}});return;}
      const controller=new AbortController();
      pending.set(message.id,{controller,method:message.method,timer:setTimeout(()=>fail(message.id,'OpenCrawl MCP request timed out.'),timeoutMs)});
      void remote.send(message,{requestSignal:controller.signal,onRequestStreamEnd:()=>fail(message.id)}).catch(()=>fail(message.id));
    }else{
      // Notifications/reverse replies have no response ID, but still need a
      // bounded lifetime. The transport-wide signal closes them on stdin EOF.
      if(++notifications>maxPending){void close();return;}
      void remote.send(message,{requestSignal:AbortSignal.timeout(timeoutMs)}).catch(()=>{}).finally(()=>{notifications--;});
    }
  };
  const aborted=()=>{void close();};
  signal?.addEventListener('abort',aborted,{once:true});
  try{if(signal?.aborted)return;await remote.start();await input.start();await done;}
  finally{signal?.removeEventListener('abort',aborted);await close();}
}

/** Dedicated entry: no updater, hook migration, skill refresh or stdout logging
 * can run while stdout belongs to the MCP protocol. */
export async function mcpCommand(args:string[]):Promise<number>{
  try{
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{api:{type:'string'},registration:{type:'string'},'installation-id':{type:'string'},help:{type:'boolean'}}});
    if(positionals.length)throw Error('Unexpected MCP argument');
    if(values.help){process.stderr.write('Usage: opencrawl mcp [--api <origin>]\nServes the configured OpenCrawl MCP over stdio, renewing existing credentials.\n');return 0;}
    const explicit=values.api??process.env.OPENCRAWL_API_URL,api=apiOrigin(explicit??readCaptureConfig()?.api??DEFAULT_API_ORIGIN);
    let validateBinding=()=>{};
    const registered=values.registration;
    if(registered||values['installation-id']){
      validateBinding=()=>{
        const config=readCaptureConfig();
        if(!registered||!values['installation-id']||config?.api!==api||config.owner.userId!==registered||
          config.installationId!==values['installation-id']||readSession(api)?.registrationId!==registered)
          throw new CliError('PLUGIN_BINDING_CHANGED','The registered workspace changed. Review setup for this installation.');
      };
      validateBinding();
    }else if(hasPluginContext()){
      if(process.env.OPENCRAWL_PLUGIN_CLIENT==='devin'){
        const {readDevinPlugin}=await import('./setup/devin-plugin.ts'),initial=readDevinPlugin(api);
        validateBinding=()=>{const current=readDevinPlugin(api);if(current.digest!==initial.digest||current.root!==initial.root)throw new CliError('PLUGIN_BINDING_CHANGED','The native plugin changed. Reconnect this plugin.');};
      }else validateBinding=()=>{pluginHookContext(api,process.env.OPENCRAWL_PLUGIN_CLIENT??'');};
      validateBinding();
    }
    return await withEnvironmentTokenOrigin(explicit,async()=>{
      const stop=new AbortController(),abort=()=>stop.abort();
      process.once('SIGINT',abort);process.once('SIGTERM',abort);
      try{
        await bridgeMcp({input:new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:65536}),
          remote:new StreamableHTTPClientTransport(new URL(api+'/mcp'),{fetch:authenticatedMcpFetch(api,{validateBinding,...(registered?{credential:async(rejected?:string,signal?:AbortSignal)=>{validateBinding();const token=await accessToken(api,rejected,fetch,signal);validateBinding();return {token,refreshable:true};}}:{})}),requestInit:{redirect:'error'},onInsufficientScope:'throw'}),signal:stop.signal});
        return 0;
      }finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
    });
  }catch{process.stderr.write('opencrawl: MCP could not start. Check the deployment, credentials and command arguments.\n');return 1;}
}
