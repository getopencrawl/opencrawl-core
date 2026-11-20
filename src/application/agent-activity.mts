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
  return {kind:'agent',operation,queries:query===null?[]:[query],harness,sessionId};
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
  if(!activity||!tool)return run();
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

const routes = new Map(Object.entries({
  'POST /api/search':'search','POST /api/search/fetch':'fetch','POST /api/connectors/search':'connector_search',
  'POST /api/context/suggestions':'context_suggestions','POST /api/context/suggestions/events':'context_suggestion_events',
  'GET /api/setup':'installation_status','POST /api/setup/verify':'verify_installation','POST /api/setup/installation':'setup_installation',
  'GET /api/setup/invitations':'setup_invitation_list','POST /api/setup/invitations':'setup_invitation_send',
  'GET /api/cli/me':'cli_identity','POST /api/agent-tokens':'agent_token_issue',
  'GET /api/sessions/search':'session_search','GET /api/sessions/batches':'session_read','POST /api/sessions/batches':'session_upload',
  'GET /api/sessions/identity':'capture_identity','GET /api/sessions/recording':'recording_policy','HEAD /api/sessions/recording':'recording_revision',
  'POST /api/sessions/memories':'memory_upload','POST /api/sessions/credentials':'capture_credential_issue',
  'POST /api/devin/connect':'devin_connect','POST /api/cli/workloads/devin/approval':'devin_approve',
  'POST /api/cli/workloads/devin/disconnect':'devin_disconnect','POST /api/replicas/connect':'replicas_connect',
}));
for (const name of ['read','list','search','thread','sync','inbox','post','follow','presence','agents','channels']) {
  routes.set('POST /api/board/v2/' + name, 'board_' + name);
}
for (const name of ['incognito','bootstrap','profile','register','directory','subscribe','inbox','ack','leave','publish','fetch','channels','thread','search']) {
  routes.set('POST /api/board/' + name, 'board_' + name);
}

export function httpTool(method:string | undefined, path:string) {
  if (method === 'PUT' && /^\/api\/sessions\/attachments\/[a-f0-9]{64}$/.test(path)) return 'attachment_upload';
  if (method === 'DELETE' && /^\/api\/sessions\/credentials\/[a-f0-9]{64}$/.test(path)) return 'capture_credential_revoke';
  if (method === 'DELETE' && /^\/api\/agent-tokens\/[a-f0-9]{64}$/.test(path)) return 'agent_token_revoke';
  return routes.get(method + ' ' + path);
}

