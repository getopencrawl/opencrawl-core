import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../../src/sessions/local-store.mjs';
import {createSessionIngest} from '../../src/sessions/ingest.mjs';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {readCaptureConfig,captureTranscript,captureDir,flushCaptures,captureStatus,captureHook} from '../src/capture/runtime.ts';
import {parseRecord,detectOrigin,hash} from '../src/capture/parse.ts';

test('Claude and Codex preserve message, tool, branch, origin and attachment records without system prompts',()=>{
  expect(parseRecord('codex',{type:'response_item',payload:{type:'message',role:'system',content:'secret'}},0)).toBeNull();
  expect(parseRecord('codex',{type:'response_item',payload:{type:'message',role:'developer',content:'repeat'}},0)).toBeNull();
  expect(parseRecord('codex',{type:'response_item',payload:{type:'function_call',call_id:'call',arguments:'{"x":1}'}},10)?.data.arguments).toBe('{"x":1}');
  expect(parseRecord('codex',{type:'response_item',payload:{type:'function_call_output',call_id:'call',output:'tool result'}},11)?.kind).toBe('tool_result');
  expect(parseRecord('claude-code',{type:'user',uuid:'next',parentUuid:'prev',message:{content:[{type:'tool_result',tool_use_id:'call',content:'code'}]}},1)?.parentId).toBe('prev');
  for(const [h,r,expected] of [
    ['codex',{payload:{source:'cli',originator:'codex_cli_rs'}},'cli'],
    ['codex',{payload:{source:'exec',originator:'Codex Desktop'}},'cli'],
    ['claude-code',{entrypoint:'sdk-cli'},'cli'],
    ['codex',{payload:{source:'vscode',originator:'Codex Desktop'}},'desktop'],
    ['claude-code',{entrypoint:'cli'},'cli'],
    ['claude-code',{entrypoint:'claude-desktop'},'desktop'],
    ['codex',{payload:{source:{subagent:{thread_spawn:{parent_thread_id:'p'}}}}},'subagent'],
  ] as const)expect(detectOrigin(h,r).origin).toBe(expected);
  expect(detectOrigin('codex',{}).origin).toBe('unknown');
});

test('install, repeat install, capture, durable upload, isolation, partial append, offline retry and uninstall',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-capture-'));
  const saved={...process.env};
  const principal={tenantId:'tenant-test',userId:'user-test',name:'Capture Test',email:'test@example.com'};
  const token='test-capture-token-01234567890123456789';
  const store=createLocalSessionStore(join(dir,'objects'));
  const ingest=createSessionIngest({store});
  const server=createServer(standaloneCapture({token,principal,store}));
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const api='http://127.0.0.1:'+(server.address() as any).port;
  try{
    process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
    process.env.OPENCRAWL_SESSIONS_TOKEN=token;
    process.env.CLAUDE_CONFIG_DIR=join(dir,'claude');
    process.env.CODEX_HOME=join(dir,'codex');
    mkdirSync(process.env.CLAUDE_CONFIG_DIR,{recursive:true});mkdirSync(process.env.CODEX_HOME,{recursive:true});
    const other={type:'command',command:'echo existing'};
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({permissions:{allow:['Read']},hooks:{Stop:[{hooks:[other]}]}}));
    writeFileSync(join(process.env.CODEX_HOME,'config.toml'),'model = "example"\n[features]\nhooks = false\nother = true\n');
    const options={background:false,home:dir,command:[process.execPath,'-e','']};
    const first=await installCapture(api,options);
    expect((await installCapture(api,options)).installationId).toBe(first.installationId);
    const settings=JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
    expect(settings.permissions).toEqual({allow:['Read']});expect(settings.hooks.Stop).toHaveLength(2);
    expect((Bun.TOML.parse(readFileSync(join(process.env.CODEX_HOME,'config.toml'),'utf8')) as any).features).toEqual({hooks:true,other:true});
    // The installed collector can authenticate after the installer environment is gone.
    delete process.env.OPENCRAWL_SESSIONS_TOKEN;
    const config=readCaptureConfig()!;
    const claude=join(config.roots['claude-code'],'projects','test','session-claude.jsonl');
    mkdirSync(join(config.roots['claude-code'],'projects','test'),{recursive:true});
    const attachment=Buffer.from('attachment fixture'),sha=hash(attachment);
    const records=[
      {type:'user',sessionId:'session-claude',entrypoint:'cli',uuid:'u1',timestamp:'2026-11-04T00:00:00Z',message:{role:'user',content:[{type:'text',text:'inspect this'},{type:'image',source:{type:'base64',media_type:'image/png',data:attachment.toString('base64')}}]}},
      {type:'assistant',sessionId:'session-claude',uuid:'a1',parentUuid:'u1',message:{role:'assistant',content:[{type:'tool_use',id:'call',name:'Read',input:{file_path:'test.ts'}}]}},
      {type:'user',sessionId:'session-claude',uuid:'u2',parentUuid:'a1',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'export const answer=42;'}]}},
    ];
    writeFileSync(claude,records.map(r=>JSON.stringify(r)+'\n').join(''));
    await captureTranscript(config,'claude-code',claude);
    expect(captureStatus().queued).toBe(1);
    await captureTranscript(config,'claude-code',claude);
    expect(captureStatus().queued).toBe(1);
    const batch=JSON.parse(readFileSync(join(captureDir(),'queue',readdirSync(join(captureDir(),'queue'))[0]),'utf8'));
    expect(batch.owner).toEqual(principal);expect(batch.origin).toBe('cli');expect(batch.events).toHaveLength(3);
    expect(batch.attachments[0].sha256).toBe(sha);
    expect(await flushCaptures()).toEqual({uploaded:1});
    const receipt={harness:batch.harness,installationId:batch.installationId,sessionId:batch.sessionId,batchId:hash(JSON.stringify(batch))};
    const fetched=await ingest.getBatch(principal,receipt);
    expect(fetched.events[2].data.content[0].content).toBe('export const answer=42;');
    expect(fetched.owner.name).toBe('Capture Test');
    expect(await ingest.getBatch({...principal,tenantId:'other'},receipt)).toBeNull();
    expect(await ingest.getBatch({...principal,userId:'other'},receipt)).toBeNull();
    await expect(ingest.putBatch({...principal,userId:'other'},batch)).rejects.toThrow('owner');
    expect((await fetch(api+'/api/sessions/identity')).status).toBe(401);
    // Partial trailing line isn't lost; completing it creates exactly one new event.
    const extra=JSON.stringify({...records[0],uuid:'u3',message:{role:'user',content:'next'}});
    appendFileSync(claude,extra.slice(0,20));await captureTranscript(config,'claude-code',claude);
    expect(captureStatus().queued).toBe(0);
    appendFileSync(claude,extra.slice(20)+'\n');await captureTranscript(config,'claude-code',claude);
    expect(captureStatus().queued).toBe(1);
    process.env.OPENCRAWL_SESSIONS_TOKEN='wrong';
    await expect(flushCaptures()).rejects.toThrow();expect(captureStatus().queued).toBe(1);
    delete process.env.OPENCRAWL_SESSIONS_TOKEN;
    expect(await flushCaptures()).toEqual({uploaded:1});
    const codex=join(config.roots.codex,'sessions','desktop.jsonl');mkdirSync(join(config.roots.codex,'sessions'));
    writeFileSync(codex,[
      {type:'session_meta',payload:{id:'codex-desktop',originator:'Codex Desktop',source:'vscode',base_instructions:'DO NOT COLLECT'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'hello'}]}},
      {type:'response_item',payload:{type:'function_call',call_id:'c1',name:'exec_command',arguments:'{"cmd":"pwd"}'}},
      {type:'response_item',payload:{type:'function_call_output',call_id:'c1',output:'test cwd'}},
      {type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}}
    ].map(r=>JSON.stringify(r)+'\n').join(''));
    await captureTranscript(config,'codex',codex);
    const cb=JSON.parse(readFileSync(join(captureDir(),'queue',readdirSync(join(captureDir(),'queue'))[0]),'utf8'));
    expect(cb.origin).toBe('desktop');expect(cb.events).toHaveLength(5);expect(JSON.stringify(cb)).not.toContain('DO NOT COLLECT');
    await flushCaptures();
    const uninstall=uninstallCapture(dir);expect(uninstall.installed).toBe(false);
    expect(captureStatus().installed).toBe(false);
    await captureHook('claude-code',{session_id:'disabled',prompt:'should not collect'});expect(captureStatus().queued).toBe(0);
    expect(JSON.parse(readFileSync(join(config.roots['claude-code'],'settings.json'),'utf8')).hooks.Stop).toEqual([{hooks:[other]}]);
  }finally{
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
    await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});
  }
});
