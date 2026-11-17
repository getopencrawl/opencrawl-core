import {test,expect} from 'bun:test';
import {parseRecord} from '../src/capture/parse.ts';

test('actual-shape Codex MCP completion survives capture without interpreting an exec echo as native MCP',()=>{
 const timestamp='2026-11-15T17:49:49.000Z';
 const record=(payload:unknown)=>({timestamp,type:'event_msg',payload});
 const payload={type:'item_completed',thread_id:'fixture-session',turn_id:'fixture-turn',started_at_ms:100,completed_at_ms:190,
  item:{type:'McpToolCall',id:'native-id',server:'opencrawl-fixture',tool:'test_connection',status:'completed',
   pluginId:'opencrawl-fixture@opencrawl-cli-fixture',arguments:{},duration:{secs:0,nanos:90000000},
   result:{content:[{type:'text',text:'synthetic result'}]}}};
 const parsed=parseRecord('codex',record(payload),3)!;
 expect(parsed.kind).toBe('mcp_tool_call_end');expect(parsed.timestamp).toBe(timestamp);expect(parsed.data).toEqual(payload);
 expect(parseRecord('codex',record({...payload,item:{type:'CommandExecution'}}),3)).toBeNull();
 expect(parseRecord('codex',record({...payload,type:'item_started'}),3)).toBeNull();
 const outer=parseRecord('codex',{timestamp,type:'response_item',payload:{type:'custom_tool_call',name:'exec',call_id:'outer',input:'text(await tools.test_connection({}))'}},2)!;
 expect(outer.kind).not.toBe('mcp_tool_call_end');
});
