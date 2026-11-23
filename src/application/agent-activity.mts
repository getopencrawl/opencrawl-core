import {AsyncLocalStorage} from 'node:async_hooks';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Principal} from '../identity/types.mjs';
import {searchDetail,type SearchActivity,type SearchEntry} from '../state/search-activity.mjs';

const searches=new Map([
  ['opencrawl_search_v1','Workspace'],['opencrawl_search','Workspace'],['search','Workspace'],
  ['board_search','Board'],['session_search','Sessions'],['connector_search','Connectors'],
]);
export function agentSearchEntry(tool:string|null,input:unknown):SearchEntry|undefined{
  const operation=tool&&searches.get(tool);
  if(!operation)return;
  const {query,harness,sessionId}=searchDetail(input);
  if(!query?.trim())return;
  return {kind:'agent',operation,queries:[query],harness,sessionId};
}
interface HttpCall {principal?:Principal; tool:string; entry?:SearchEntry}
const active=new AsyncLocalStorage<HttpCall>();
export function admitActivity(p:Principal){
  const call=active.getStore();
  if(call&&!call.principal)call.principal=p;
}
export function activityInput(input:unknown){
  const call=active.getStore();
  if(call)call.entry=agentSearchEntry(call.tool,input);
}
export function observeAgentRequest<T>(activity:SearchActivity|undefined,tool:string|undefined,req:IncomingMessage,res:ServerResponse,run:()=>Promise<T>){
  if(!activity||!tool||req.headers.origin!==undefined)return run();
  const call:HttpCall={tool,entry:agentSearchEntry(tool,undefined)};
  return active.run(call,async()=>{
    if(tool==='session_search')activityInput({query:new URL(req.url!,'http://localhost').searchParams.get('q')??''});
    try{return await run();}
    finally{
      if(call.principal)await activity.agentCall(call.principal,call.entry && {...call.entry,failed:res.statusCode>=400||!res.writableEnded})
        .catch(()=>console.error(JSON.stringify({event:'usage.write_failed',transport:'http'})));
    }
  });
}

// A service request alone does not prove a tool invocation. HTTP routes shared
// with capture, listeners, startup hooks or onboarding have no foreground signal.
// MCP tools/call is observed at dispatch and does not use this route classifier.
const routes = new Map(Object.entries({
  'POST /api/search':'search','POST /api/browse':'browse','POST /api/search/fetch':'fetch','POST /api/connectors/search':'connector_search',
  'GET /api/sessions/search':'session_search','GET /api/sessions/batches':'session_read',
}));
for (const name of ['read','list','search','thread','post','follow','agents','channels']) {
  routes.set('POST /api/board/v2/' + name, 'board_' + name);
}
for (const name of ['directory','subscribe','publish','fetch','channels','thread','search']) {
  routes.set('POST /api/board/' + name, 'board_' + name);
}

const foregroundTools=new Set(routes.values());
export function isAgentHttpTool(name:unknown):boolean {
  return typeof name==='string' && foregroundTools.has(name);
}
export function httpTool(method:string | undefined, path:string) {
  return routes.get(method + ' ' + path);
}
