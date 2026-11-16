import {test,expect} from 'bun:test';
import {parseRecord} from '../src/capture/parse.ts';
import {createSetupStatus} from '../../dist/src/setup/status.mjs';
import {memoryApplicationState} from '../../test/fixtures/memory-application-state.mjs';
import type {SessionBatch,SessionEvent} from '../../src/sessions/types.mts';

test('actual-shape Codex completion survives capture and proves native MCP; an exec echo cannot',async()=>{
  const owner={tenantId:'fixture-org',userId:'fixture-user'},selection={installationId:'fixture-installation',client:'codex'};
  let time=Date.parse('2026-11-15T17:49:49.000Z');
  const unexpectedSearch=async()=>{throw new Error('MCP evidence must not imply search verification');};
  const setup=createSetupStatus({state:memoryApplicationState(),search:{search:unexpectedSearch,fetch:unexpectedSearch},now:()=>new Date(time)});
  await setup.installation(owner,{installationId:selection.installationId,machine:{id:'fixture-machine',label:'Fixture'},clients:[{
    client:'codex',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending'}]});
  const proof=(await setup.verify(owner,selection)).proof;time+=1000;
  const batch=(events:SessionEvent[]):SessionBatch=>({schemaVersion:1,installationId:selection.installationId,sessionId:'fixture-session',harness:'codex',origin:'cli',captureMode:'live',owner,events,attachments:[]});
  const record=<T>(type:string,payload:T)=>({timestamp:new Date(time).toISOString(),type,payload});
  const marker=parseRecord('codex',record('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:proof.marker}]}),1)!;
  await setup.session(owner,batch([marker]));
  const result=await setup.mcp(owner,{...selection,proofId:proof.id});time+=100;
  const input={...selection,proofId:proof.id};
  const outer=[
    parseRecord('codex',record('response_item',{type:'custom_tool_call',name:'exec',call_id:'outer-call',input:`text(await tools.mcp__opencrawl_0123456789ab__verify_installation(${JSON.stringify(input)}))`}),2)!,
    parseRecord('codex',record('response_item',{type:'custom_tool_call_output',call_id:'outer-call',output:[{type:'text',text:JSON.stringify(result)}]}),4)!,
  ];
  await setup.session(owner,batch(outer));
  expect((await setup.read(owner)).installations[0].clients[0].mcp.state).toBe('observed');
  const native=record('event_msg',{type:'item_completed',thread_id:'fixture-session',turn_id:'fixture-turn',started_at_ms:time-90,completed_at_ms:time,
    item:{type:'McpToolCall',id:'exec-inner-native-id',server:'opencrawl-0123456789ab',tool:'verify_installation',status:'completed',
      pluginId:'opencrawl-0123456789ab@opencrawl-cli-0123456789ab',arguments:input,duration:{secs:0,nanos:90000000},
      result:{content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}}});
  const parsed=parseRecord('codex',native,3)!;
  expect(parsed.kind).toBe('mcp_tool_call_end');expect(parsed.timestamp).toBe(native.timestamp);expect(parsed.data).toEqual(native.payload);
  expect(parseRecord('codex',record('event_msg',{...native.payload,item:{type:'CommandExecution'}}),3)).toBeNull();
  expect(parseRecord('codex',record('event_msg',{...native.payload,type:'item_started'}),3)).toBeNull();
  await setup.session(owner,batch([parsed]));
  const client=(await setup.read(owner)).installations[0].clients[0];
  expect(client.mcp.state).toBe('authenticated');expect(client.proof.state).toBe('waiting_index');
});
