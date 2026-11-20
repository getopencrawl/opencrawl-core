import {test,expect} from 'bun:test';
import {agentBoardInput,renderBoard} from '../src/board-agent.ts';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {compactDelivery,boardStateFile,saveBoardRegistration,supportsAgentBoard} from '../src/board.ts';
import {searchContext,searchContextCommand} from '../src/search-context.ts';

test('CLI queries use the same message filters and projection as MCP',()=>{
 expect(agentBoardInput('search',{channel:['engineering'],from:['@codex:owner'],after:'42',limit:'3',order:'oldest',select:'from,text'},['release','failure']))
  .toEqual({query:'release failure',channels:['engineering'],from:['@codex:owner'],after:42,limit:3,order:'oldest',select:['from','text']});
 expect(agentBoardInput('presence',{session:'s',channel:['work'],'channel-mode':'remove'},[]))
  .toEqual({session:'s',channels:['work'],channelMode:'remove'});
 expect(agentBoardInput('read',{},['42','message:43'])).toEqual({ids:[42,43]});
 expect(agentBoardInput('thread',{after:'43'},['42'])).toEqual({threadId:42,after:43});
 expect(()=>agentBoardInput('read',{},['bad'])).toThrow();
});

test('compact receipts, metadata selection and thread notification hints use the native interface',()=>{
 expect(agentBoardInput('list',{select:'metadata'},[]).select).toEqual(['metadata']);
 expect(agentBoardInput('reply',{text:'saved',full:true},['2']).full).toBe(true);
 const [root,reply]=compactDelivery([{id:1,threadId:1,text:'root'},{id:2,threadId:1,text:'reply'}]);
 expect(root.unfollow).toBeUndefined();
 expect(reply.unfollow).toBe('opencrawl board unfollow 1');
});

test('reply does not require a channel or root ID and retries retain explicit keys',()=>{
 const result=agentBoardInput('reply',{session:'native',id:'retry-key',text:'First\n\nSecond',mention:['@codex:peer'],'no-follow':true},['43']);
 expect(JSON.parse(JSON.stringify(result))).toEqual({session:'native',posts:[{id:'retry-key',text:'First\n\nSecond',replyTo:43,mentions:['@codex:peer'],follow:false}]});
 expect(()=>agentBoardInput('post',{text:'a','text-file':'b'},[])).toThrow();
 expect(()=>agentBoardInput('post',{text:'a',json:true,jsonl:true},[])).toThrow();
 expect(()=>agentBoardInput('reply',{text:'a'},['1','2'])).toThrow();
 expect(()=>agentBoardInput('reply',{text:'a',thread:'1'},['2'])).toThrow();
});

test('JSON and JSONL contain only message records and preserve full text',()=>{
 const message={id:42,from:'codex:owner',channel:'work',thread:42,replyTo:null,time:'2026-11-17T00:00:00.000Z',text:'Long\n'+ '🧪'.repeat(5000),mentions:[]};
 let out='',err='';const stdout={write(value:string){out+=value;return true;}},stderr={write(value:string){err+=value;return true;}};
 renderBoard({messages:[message],next:'cursor'},{json:true},stdout,stderr);expect(JSON.parse(out)).toEqual({messages:[message],next:'cursor'});expect(err).toBe('');
 out='';renderBoard({messages:[message],next:'cursor'},{jsonl:true},stdout,stderr);expect(JSON.parse(out)).toEqual(message);expect(JSON.parse(err)).toEqual({next:'cursor'});
});

test('native board identity comes from this session and retains publication arguments',()=>{
 for(const harness of ['codex','claude-code'])for(const tool of ['board_post','board_sync','board_presence','board_follow']){
  const args={agent:'codex:owner',posts:[{id:'one',channel:'work',text:'Evidence'}],currentSession:{harness:'codex',sessionId:'wrong'}};
  const result=searchContext(harness,{hook_event_name:'PreToolUse',tool_name:'mcp__opencrawl__'+tool,session_id:'native',tool_input:args},undefined,true) as {hookSpecificOutput:{updatedInput:typeof args}};
  expect(result.hookSpecificOutput.updatedInput).toEqual({...args,currentSession:{harness,sessionId:'native'}});
  expect(searchContext(harness,{hook_event_name:'PreToolUse',tool_name:'mcp__opencrawl__'+tool,session_id:'native',tool_input:args})).toBeUndefined();
 }
 expect(searchContext('codex',{hook_event_name:'PreToolUse',tool_name:'mcp__other__board_post',session_id:'native',tool_input:{}})).toBeUndefined();
});
test('native identity injection follows authenticated server capability without rewriting delivery checkpoints',async()=>{
 const home=mkdtempSync(join(tmpdir(),'board-capability-')),prior=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=home;
 const api='https://board-capability.example',session='native',receipt={workspace:'team',agent:'a'.repeat(64),name:'codex:owner'};
 let output='';const sink={write(value:string){output+=value;return true;}},event={hook_event_name:'PreToolUse',session_id:session,tool_name:'mcp__opencrawl__board_post',tool_input:{posts:[{id:'one',channel:'work',text:'Complete'}]}};
 try{
  saveBoardRegistration(api,session,receipt);expect(supportsAgentBoard(api)).toBe(false);
  const before=readFileSync(boardStateFile(api,session),'utf8');
  await searchContextCommand(['--harness','codex','--api',api],Readable.from([JSON.stringify(event)]),sink);expect(output).toBe('');
  saveBoardRegistration(api,session,{...receipt,boardProtocol:2});expect(supportsAgentBoard(api)).toBe(true);expect(readFileSync(boardStateFile(api,session),'utf8')).toBe(before);
  await searchContextCommand(['--harness','codex','--api',api],Readable.from([JSON.stringify(event)]),sink);
  expect(JSON.parse(output).hookSpecificOutput.updatedInput).toEqual({...event.tool_input,currentSession:{harness:'codex',sessionId:session}});
  saveBoardRegistration(api,session,receipt);expect(supportsAgentBoard(api)).toBe(false);
 }finally{if(prior===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=prior;rmSync(home,{recursive:true,force:true});}
});
