import {test, expect} from 'bun:test';
import {PassThrough, Readable} from 'node:stream';
import {searchContext, searchContextCommand, readSearchContextEvent} from '../src/search-context.ts';

const input = {query:'release failure', filters:{roles:['assistant']}, includeCurrentSession:true, includeToolOutputs:true,
  currentSession:{harness:'codex',sessionId:'stale'}, cursor:'keep-cursor'};
const event = {hook_event_name:'PreToolUse',session_id:'parent',tool_name:'mcp__opencrawl__opencrawl_search',tool_input:input};

test('native search identity replaces stale arguments while preserving queries and explicit overrides',()=>{
  const result = searchContext('claude-code',event) as any;
  expect(result.hookSpecificOutput).toEqual({hookEventName:'PreToolUse',updatedInput:{...input,currentSession:{harness:'claude-code',sessionId:'parent'}}});
  expect(result.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(input.currentSession.sessionId).toBe('stale');
  const codex = searchContext('codex',event) as any;
  expect(codex.hookSpecificOutput.permissionDecision).toBe('allow');
  expect(codex.hookSpecificOutput.updatedInput.currentSession).toEqual({harness:'codex',sessionId:'parent'});
});

test('subagents use the same native identity as capture, not their parent or display name',()=>{
  expect((searchContext('codex',{...event,agent_id:'child-native',agent_type:'reviewer'}) as any).hookSpecificOutput.updatedInput.currentSession)
    .toEqual({harness:'codex',sessionId:'child-native'});
  expect((searchContext('claude-code',{...event,agent_id:'child-native',agent_type:'reviewer'}) as any).hookSpecificOutput.updatedInput.currentSession)
    .toEqual({harness:'claude-code',sessionId:'parent:child-native'});
  for(const agent_id of ['', 'bad/id', 123]) expect(searchContext('codex',{...event,agent_id})).toBeUndefined();
  expect(searchContext('claude-code',{...event,session_id:'a'.repeat(200),agent_id:'child'})).toBeUndefined();
});

test('only exact OpenCrawl search tools receive caller identity',()=>{
  for(const tool_name of ['mcp__opencrawl__opencrawl_search','mcp__plugin_opencrawl_opencrawl__opencrawl_search','mcp__codex_apps__opencrawl_opencrawl_search'])
    expect(searchContext('codex',{...event,tool_name})).toBeDefined();
  for(const tool_name of ['search','mcp__opencrawl__search','mcp__plugin_opencrawl_opencrawl__search','mcp__codex_apps__opencrawl_search',
    'mcp__other__search','mcp__opencrawl__board_search','mcp__notopencrawl__search','mcp__opencrawl__search_more','Bash'])
    expect(searchContext('codex',{...event,tool_name})).toBeUndefined();
  for(const patch of [{session_id:undefined},{session_id:'bad/id'},{hook_event_name:'PostToolUse'},{tool_input:null},{tool_input:[]}])
    expect(searchContext('codex',{...event,...patch})).toBeUndefined();
  expect(searchContext('other',event)).toBeUndefined();
});

test('Cursor uses its native conversation ID only for the unique OpenCrawl alias',()=>{
  const cursor={hook_event_name:'preToolUse',conversation_id:'cursor-conversation',session_id:'other-session',tool_name:'MCP:opencrawl_search',tool_input:input};
  expect(searchContext('cursor',cursor)).toEqual({updated_input:{...input,currentSession:{harness:'cursor',sessionId:'cursor-conversation'}}});
  expect(searchContext('cursor',{...cursor,conversation_id:undefined})).toEqual({updated_input:{...input,currentSession:{harness:'cursor',sessionId:'other-session'}}});
  for(const patch of [{tool_name:'MCP:search'},{tool_name:'opencrawl_search'},{tool_name:'MCP:other_opencrawl_search'},
    {conversation_id:'bad/id'},{hook_event_name:'postToolUse'},{tool_input:null}]) expect(searchContext('cursor',{...cursor,...patch})).toBeUndefined();
});

test('Antigravity shallow overwrite preserves native tool arguments without granting approval',()=>{
  const agy={hookEventName:'PreToolUse',conversationId:'agy-conversation',toolCall:{name:'mcp_opencrawl_opencrawl_search',args:input}};
  expect(searchContext('antigravity',agy)).toEqual({decision:'allow',overwrite:{currentSession:{harness:'antigravity',sessionId:'agy-conversation'}}});
  for(const name of ['search','mcp_opencrawl_search','mcp_other_search','mcp_other_opencrawl_search','mcp_opencrawl_search_other'])
    expect(searchContext('antigravity',{...agy,toolCall:{name,args:input}})).toBeUndefined();
  expect(searchContext('antigravity',{...agy,conversationId:'bad/id'})).toBeUndefined();
});

test('hook input is bounded and does not wait for a native stdin stream to close',async()=>{
  const open = new PassThrough(), result = readSearchContextEvent(open,100,1000);open.write(JSON.stringify(event));
  expect(await result).toEqual(event);expect(open.destroyed).toBe(false);open.destroy();
  await expect(readSearchContextEvent(Readable.from(['x'.repeat(1001)]),100,1000)).rejects.toThrow();
  await expect(readSearchContextEvent(Readable.from(['{']),100,1000)).rejects.toThrow();
  const idle = new PassThrough();await expect(readSearchContextEvent(idle,10,1000)).rejects.toThrow();idle.destroy();
});

test('command produces only a hook response and stays quiet for unknown identities',async()=>{
  let output='';const sink={write(chunk:any){output+=String(chunk);return true;}};
  expect(await searchContextCommand(['--harness','codex'],Readable.from([JSON.stringify(event)]),sink)).toBe(0);
  expect(JSON.parse(output).hookSpecificOutput.updatedInput.currentSession.sessionId).toBe('parent');
  output='';expect(await searchContextCommand(['--harness','codex'],Readable.from(['{}']),sink)).toBe(0);expect(output).toBe('');
});
