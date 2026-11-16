import {test, expect} from 'bun:test';
import {PassThrough, Readable} from 'node:stream';
import {searchContext, searchContextCommand, readSearchContextEvent, searchContextMatcher, cursorSearchContextMatcher, antigravitySearchContextMatcher, pluginSearchContextMatcher} from '../src/search-context.ts';

const input = {query:'release failure', filters:{roles:['assistant']}, includeCurrentSession:true, includeToolOutputs:true,
  currentSession:{harness:'codex',sessionId:'stale'}, cursor:'keep-cursor'};
const event = {hook_event_name:'PreToolUse',session_id:'parent',tool_name:'mcp__opencrawl__opencrawl_search_v1',tool_input:input};

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
  const matcher=new RegExp(searchContextMatcher);
  for(const tool_name of ['mcp__opencrawl__opencrawl_search','mcp__plugin_opencrawl_opencrawl__opencrawl_search','mcp__codex_apps__opencrawl_opencrawl_search',
    'mcp__opencrawl__opencrawl_search_v1','mcp__plugin_opencrawl_opencrawl__opencrawl_search_v1','mcp__codex_apps__opencrawl_opencrawl_search_v1']) {
    expect(matcher.test(tool_name)).toBe(true);
    for(const harness of ['codex','claude-code']) {
      const result=searchContext(harness,{...event,tool_name}) as any;
      expect(result.hookSpecificOutput.updatedInput).toEqual({...input,currentSession:{harness,sessionId:'parent'}});
      expect(result.hookSpecificOutput.permissionDecision).toBe(harness==='codex'?'allow':undefined);
    }
  }
  for(const tool_name of ['search','mcp__opencrawl__search','mcp__plugin_opencrawl_opencrawl__search','mcp__codex_apps__opencrawl_search',
    'mcp__other__search','mcp__opencrawl__board_search','mcp__notopencrawl__search','mcp__opencrawl__search_more','Bash',
    'mcp__opencrawl__search_v1','mcp__other__opencrawl_search_v1','mcp__opencrawl__opencrawl_search_v10','mcp__opencrawl__opencrawl_search_v1_more']) {
    expect(matcher.test(tool_name)).toBe(false);
    expect(searchContext('codex',{...event,tool_name})).toBeUndefined();
  }
  for(const patch of [{session_id:undefined},{session_id:'bad/id'},{hook_event_name:'PostToolUse'},{tool_input:null},{tool_input:[]}])
    expect(searchContext('codex',{...event,...patch})).toBeUndefined();
  expect(searchContext('other',event)).toBeUndefined();
});

test('Cursor uses its native conversation ID only for the unique OpenCrawl alias',()=>{
  const cursor={hook_event_name:'preToolUse',conversation_id:'cursor-conversation',session_id:'other-session',tool_name:'MCP:opencrawl_search_v1',tool_input:input};
  const matcher=new RegExp(cursorSearchContextMatcher);
  for(const tool_name of ['MCP:opencrawl_search','MCP:opencrawl_search_v1']) {
    expect(matcher.test(tool_name)).toBe(true);
    expect(searchContext('cursor',{...cursor,tool_name})).toEqual({updated_input:{...input,currentSession:{harness:'cursor',sessionId:'cursor-conversation'}}});
  }
  expect(searchContext('cursor',{...cursor,conversation_id:undefined})).toEqual({updated_input:{...input,currentSession:{harness:'cursor',sessionId:'other-session'}}});
  for(const tool_name of ['MCP:search','MCP:search_v1','opencrawl_search_v1','MCP:other_opencrawl_search_v1','MCP:opencrawl_search_v10','MCP:opencrawl_search_v1_more']) {
    expect(matcher.test(tool_name)).toBe(false);
    expect(searchContext('cursor',{...cursor,tool_name})).toBeUndefined();
  }
  for(const patch of [{tool_name:'opencrawl_search'},{tool_name:'MCP:other_opencrawl_search'},
    {conversation_id:'bad/id'},{hook_event_name:'postToolUse'},{tool_input:null}]) expect(searchContext('cursor',{...cursor,...patch})).toBeUndefined();
});

test('Antigravity manual and plugin v1 calls attach identity while rejecting the legacy name collision',()=>{
  const agy={hookEventName:'PreToolUse',conversationId:'agy-conversation',toolCall:{name:'mcp_opencrawl_opencrawl_search_v1',args:input}};
  const matcher=new RegExp(antigravitySearchContextMatcher);
  for(const name of ['mcp_opencrawl_opencrawl_search_v1','mcp_opencrawl_opencrawl_opencrawl_search_v1']) {
    expect(matcher.test(name)).toBe(true);
    const result=searchContext('antigravity',{...agy,toolCall:{name,args:input}}) as any;
    expect(result).toEqual({decision:'allow',overwrite:{currentSession:{harness:'antigravity',sessionId:'agy-conversation'}}});
    expect({...input,...result.overwrite}).toEqual({...input,currentSession:{harness:'antigravity',sessionId:'agy-conversation'}});
  }
  // Plugin opencrawl/server opencrawl/raw search collides with the former
  // manual-server preferred alias. HookToolCall has no server discriminator.
  for(const name of ['mcp_opencrawl_opencrawl_search','mcp_opencrawl_opencrawl_opencrawl_search',
    'search','mcp_opencrawl_search','mcp_opencrawl_search_v1','mcp_other_search','mcp_other_opencrawl_search_v1',
    'mcp_other_opencrawl_opencrawl_search_v1','mcp_opencrawl_search_other','mcp_opencrawl_opencrawl_search_v10','mcp_opencrawl_opencrawl_search_v1_more']) {
    expect(matcher.test(name)).toBe(false);
    expect(searchContext('antigravity',{...agy,toolCall:{name,args:input}})).toBeUndefined();
  }
  expect(searchContext('antigravity',{...agy,conversationId:'bad/id'})).toBeUndefined();
  expect(searchContext('antigravity',{...agy,hookEventName:'PostToolUse'})).toBeUndefined();
});

test('Antigravity generic MCP dispatch rewrites only the exact v1 target and preserves nested arguments',()=>{
  const matcher=new RegExp(antigravitySearchContextMatcher);
  expect(matcher.test('call_mcp_tool')).toBe(true);
  for(const ServerName of ['opencrawl','opencrawl_opencrawl']) {
    const args={ServerName,ToolName:'opencrawl_search_v1',Arguments:input,other:{preserve:true}};
    const agy={hookEventName:'PreToolUse',conversationId:'agy-wrapper',toolCall:{id:'native-tool-call',name:'call_mcp_tool',args}};
    const before=JSON.stringify(agy);
    const result=searchContext('antigravity',agy) as any;
    expect(result).toEqual({decision:'allow',overwrite:{Arguments:{...input,currentSession:{harness:'antigravity',sessionId:'agy-wrapper'}}}});
    // The native client performs a top-level merge; replace Arguments with a
    // complete copy so query, cursor, filters and explicit overrides survive.
    expect({...args,...result.overwrite}).toEqual({...args,Arguments:{...input,currentSession:{harness:'antigravity',sessionId:'agy-wrapper'}}});
    expect(JSON.stringify(agy)).toBe(before);
    for(const patch of [{ServerName:'other'}, {ServerName:'opencrawl_other'}, {ServerName:'other_opencrawl'},
      {ToolName:'search'}, {ToolName:'opencrawl_search'}, {ToolName:'search_v1'}, {ToolName:'opencrawl_search_v10'},
      {Arguments:JSON.stringify(input)}, {Arguments:[]}, {Arguments:null}, {Arguments:undefined}])
      expect(searchContext('antigravity',{...agy,toolCall:{...agy.toolCall,args:{...args,...patch}}})).toBeUndefined();
    expect(searchContext('antigravity',{...agy,conversationId:'bad/id'})).toBeUndefined();
    expect(searchContext('antigravity',{...agy,hookEventName:'PostToolUse'})).toBeUndefined();
  }
  expect(matcher.test('call_mcp_tool_other')).toBe(false);
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

test('command decodes the native GUI wrapper without parsing string Arguments or changing foreign calls',async()=>{
  const event={hookEventName:'PreToolUse',conversationId:'native-gui',toolCall:{name:'call_mcp_tool',args:{
    ServerName:'opencrawl_opencrawl',ToolName:'opencrawl_search_v1',Arguments:input}}};
  let output='';const sink={write(chunk:any){output+=String(chunk);return true;}};
  expect(await searchContextCommand(['--harness','antigravity'],Readable.from([JSON.stringify(event)]),sink)).toBe(0);
  expect(JSON.parse(output)).toEqual({decision:'allow',overwrite:{Arguments:{...input,currentSession:{harness:'antigravity',sessionId:'native-gui'}}}});
  for(const patch of [{ServerName:'other'}, {ToolName:'search'}, {ToolName:'opencrawl_search'}, {Arguments:JSON.stringify(input)}]) {
    output='';
    const foreign={...event,toolCall:{...event.toolCall,args:{...event.toolCall.args,...patch}}};
    expect(await searchContextCommand(['--harness','antigravity'],Readable.from([JSON.stringify(foreign)]),sink)).toBe(0);
    expect(output).toBe('');
  }
});


test('deployment plugins rewrite only their exact native MCP namespace and preserve native identity',()=>{
  const plugin='opencrawl-123456abcdef',foreign='opencrawl-fedcba654321';
  for(const harness of ['codex','claude-code']) {
    const prefix=(name:string)=>harness==='codex'?`mcp__${name}__`:`mcp__plugin_${name}_opencrawl__`;
    const matcher=new RegExp(pluginSearchContextMatcher(harness,plugin));
    for(const name of [plugin,plugin.replaceAll('-','_')])for(const alias of ['opencrawl_search','opencrawl_search_v1']) {
      const tool_name=prefix(name)+alias;
      expect(matcher.test(tool_name)).toBe(true);
      expect((searchContext(harness,{...event,tool_name},plugin) as any).hookSpecificOutput.updatedInput.currentSession).toEqual({harness,sessionId:'parent'});
    }
    for(const tool_name of [prefix(foreign)+'opencrawl_search_v1',prefix(plugin)+'search','mcp__opencrawl__opencrawl_search_v1',prefix(plugin)+'opencrawl_search_v10']) {
      expect(matcher.test(tool_name)).toBe(false);expect(searchContext(harness,{...event,tool_name},plugin)).toBeUndefined();
    }
    expect(searchContext(harness,{...event,tool_name:prefix(plugin)+'opencrawl_search_v1',cursor_version:'imported-plugin'},plugin)).toBeUndefined();
  }
  const agy=(ServerName:string)=>({hookEventName:'PreToolUse',conversationId:'actual-chat',toolCall:{name:'call_mcp_tool',args:{ServerName,ToolName:'opencrawl_search_v1',Arguments:input}}});
  expect(searchContext('antigravity',agy(plugin+'_opencrawl'),plugin)).toEqual({decision:'allow',overwrite:{Arguments:{...input,currentSession:{harness:'antigravity',sessionId:'actual-chat'}}}});
  for(const server of ['opencrawl','opencrawl_opencrawl',foreign+'_opencrawl'])expect(searchContext('antigravity',agy(server),plugin)).toBeUndefined();
  const name='mcp_'+plugin+'_opencrawl_opencrawl_search_v1';
  expect(new RegExp(pluginSearchContextMatcher('antigravity',plugin)).test(name)).toBe(true);
  expect(searchContext('antigravity',{...agy('unused'),toolCall:{name,args:input}},plugin)).toEqual({decision:'allow',overwrite:{currentSession:{harness:'antigravity',sessionId:'actual-chat'}}});
  // Cursor supplies only its native alias: its plugin binding is validated by
  // the command, while its current conversation remains independent of scope.
  expect(searchContext('cursor',{hook_event_name:'preToolUse',conversation_id:'actual-chat',tool_name:'MCP:opencrawl_search_v1',tool_input:input},plugin)).toEqual({updated_input:{...input,currentSession:{harness:'cursor',sessionId:'actual-chat'}}});
});
