import type {SetupState} from './state.ts';
import type {SetupServerStatus} from './api.ts';

export function deferredPlugins(state:SetupState){
 return (state.pluginResults??[]).filter(row=>state.selections.plugins[row.client]&&(row.captureAvailable===false||row.status==='error'||row.status==='pending'));
}

/** Never let one ready harness hide another selected harness's pending proof. */
export function nextSetupAction(state:SetupState,server:SetupServerStatus){
 const selected=Object.keys(state.selections.plugins).filter(id=>state.selections.plugins[id]);
 if(!selected.length)return {actor:'agent',kind:'complete',instruction:'No harness is selected for recording. Continue the conversation.'} as const;
 if(!state.installationId)return {actor:'agent',kind:'review_setup',instruction:'Read setup --json. Ask only for choices that have not been saved.'} as const;
 const deferred=deferredPlugins(state);
 const available=selected.filter(id=>!deferred.some(row=>row.client===id));
 if((available.length||state.worker?.kind==='configuring')&&state.worker?.supervised===false&&state.worker.kind!=='not-required')return {actor:'agent',kind:'repair_worker',instruction:'The capture worker is not supervised. Inspect setup status --local --json and repair its reported service. Keep the saved choices.'} as const;
 const installation=server.installations.find(row=>row.installationId===state.installationId);
 for(const id of available){
  const client=installation?.clients.find(row=>row.client===id),forward=state.selections.forward[id];
  const connected=client?.mcp?.state==='authenticated'||!forward&&client?.mcp?.state==='observed';
  if(connected&&(!forward||client?.proof?.state==='verified')){
   const prepared=state.pluginResults?.find(row=>row.client===id&&row.status==='prepared'&&row.preparedAt);
   if(prepared&&!(Date.parse(client?.captureObservedAt??'')>=Date.parse(prepared.preparedAt!)))
    return {actor:'agent',kind:'review_setup',client:id,instruction:'The previous capture confirmation predates this local plugin installation. Keep activation pending until this workspace observes capture from the current Cursor installation.'} as const;
   if(client?.installed&&!prepared)continue;
   return {actor:'agent',kind:'reconcile_activation',client:id,instruction:'Run setup --yes --json once to report the activated plugin, then read setup next --json. Preserve saved choices.'} as const;
  }
  if(['observed','authenticated'].includes(client?.mcp?.state??'')&&['waiting_capture','waiting_index'].includes(client?.proof?.state??''))return {actor:'agent',kind:'wait_capture',client:id,arguments:['setup','wait','--json'],instruction:'Run setup wait --json with this profile-bound CLI. It waits for native capture and indexing. Follow the returned nextAction. Do not ask the person to reply or type a test message.'} as const;
  return {actor:'agent',kind:'native_tool',requiresSignIn:!['observed','authenticated'].includes(client?.mcp?.state??''),tool:'installation_status',arguments:{installationId:state.installationId,client:id},instruction:`Use the installed OpenCrawl MCP connection in ${id}. Follow its proof instructions in that harness. Ask the person only for a required sign-in or trust click; do not repeat saved choices or request a verification message.`,retryAfterMs:3000} as const;
 }
 const deferredClients=deferred.map(row=>row.client);
 const unavailable=deferred.find(row=>row.captureAvailable===false);
 const pending=deferred[0];
 if(unavailable)return {actor:'agent',kind:'plugin_unavailable',client:unavailable.client,deferredClients,instruction:'This pinned plugin package does not implement capture yet. Setup remains incomplete. Preserve the saved choices; run setup again when a capture-capable package is available.'} as const;
 if(pending){
  const task=state.humanTasks?.find(task=>task.client===pending.client&&task.kind==='plugin_install');
  return {actor:'agent',kind:'repair_plugin',client:pending.client,deferredClients,reason:pending.message,title:task?.title,instruction:task?.instruction??'Read setup status --local --json and resolve the reported native plugin issue before running setup. Preserve native trust, disabled plugins and saved choices.'} as const;
 }
 return {actor:'agent',kind:'complete',instruction:'All selected harnesses are verified. Continue the conversation.'} as const;
}
