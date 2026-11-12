import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {PassThrough} from 'node:stream';
import {readStartEvent, sessionStart} from '../src/session-start.ts';
import {startupHooks, startupMarker} from '../src/startup-install.ts';
import {boardStateFile, saveBoardRegistration, boardRequest} from '../src/board.ts';
import {sessionFile} from '../src/session.ts';

async function fixture(run: (home: string) => Promise<void> | void) {
  const home=mkdtempSync(join(tmpdir(),'opencrawl-start-')), saved=process.env.OPENCRAWL_CONFIG_HOME;
  process.env.OPENCRAWL_CONFIG_HOME=join(home,'config');
  try {await run(home);} finally {if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;rmSync(home,{recursive:true,force:true});}
}
const event={hook_event_name:'SessionStart',session_id:'native-123',source:'startup'};
const registration={workspace:'test',agent:'a'.repeat(64),session:'native-123',name:null,task:null};

test('native input is bounded and completes without waiting for stdin to close',async()=>{
  const input=new PassThrough(), result=readStartEvent(input,100);
  input.write(JSON.stringify(event)); expect(await result).toEqual(event);
  const large=new PassThrough(), rejected=expect(readStartEvent(large,100)).rejects.toThrow();
  large.end('x'.repeat(16_385));await rejected;
  await expect(readStartEvent(new PassThrough(),10)).rejects.toThrow();
});

test('bootstrap exposes only confirmed metadata, preserves checkpoints, and does not read transcripts',()=>fixture(async()=>{
  const api='http://127.0.0.1:8093'; let calls=0;
  const request: typeof boardRequest=async(_api,operation,input,_fetch,options)=>{
    calls++;expect(operation).toBe('bootstrap');expect(input).toEqual({session:event.session_id,harness:'codex'});
    expect(options?.refresh).toBe(false);expect(options?.signal).toBeInstanceOf(AbortSignal);
    return registration;
  };
  const output=await sessionStart(api,'codex',{...event,transcript_path:'/must-not-be-read'},request);
  expect(output.hookSpecificOutput.additionalContext).toContain('Choose your own display name');
  expect(output.hookSpecificOutput.additionalContext).toContain('does not attach a listener');
  const file=boardStateFile(api,event.session_id), receipt={...registration,lastEmitted:'saved-receipt'};
  writeFileSync(file,JSON.stringify(receipt));const before=statSync(file).mtimeMs;
  saveBoardRegistration(api,event.session_id,{...registration,name:'codex:chosen'});
  expect(statSync(file).mtimeMs).toBe(before);expect(JSON.parse(readFileSync(file,'utf8')).lastEmitted).toBe('saved-receipt');
  expect((await sessionStart(api,'codex',{...event,session_id:'bad; command'},request)).hookSpecificOutput.additionalContext).toContain('unavailable');
  expect(calls).toBe(1);
  const invalid=await sessionStart(api,'codex',event,async()=>({...registration,session:'wrong'}));
  expect(invalid.hookSpecificOutput.additionalContext).toContain('could not be confirmed');
}));

test('expired authentication never rotates credentials inside the bounded hook',()=>fixture(async()=>{
  const api='https://startup-test.example', file=sessionFile(api);
  mkdirSync(join(file,'..'),{recursive:true});
  const data=JSON.stringify({auth:{clientId:'test',tokenEndpoint:'https://startup-test.example/token'},accessToken:'DO-NOT-PRINT',refreshToken:'DO-NOT-ROTATE',expiresAt:0});
  writeFileSync(file,data,{mode:0o600});
  let requests=0;
  await expect(boardRequest(api,'bootstrap',{},(async()=>{requests++;throw new Error();}) as unknown as typeof fetch,{refresh:false})).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  expect(requests).toBe(0);expect(readFileSync(file,'utf8')).toBe(data);
  const context=(await sessionStart(api,'codex',event)).hookSpecificOutput.additionalContext;
  expect(context).toContain('opencrawl whoami');expect(context).not.toContain('DO-NOT-');
}));

test('startup installation preserves capture and user hooks, is idempotent, and respects disable switches',()=>fixture(home=>{
  const options={home,env:{},node:process.execPath,command:[process.execPath,resolve(import.meta.dir,'../src/cli.ts')]};
  const root=join(home,'.claude');mkdirSync(root);
  const file=join(root,'settings.json');
  const existing={permissions:{allow:['Read']},hooks:{SessionStart:[{matcher:'startup',hooks:[{type:'command',command:'capture',async:true,statusMessage:'OpenCrawl session capture'}]}],Stop:[{hooks:[{type:'command',command:'user'}]}]}};
  writeFileSync(file,JSON.stringify(existing,null,4),{mode:0o640});
  expect(startupHooks(['claude-code'],'install',options)[0]!.status).toBe('installed');
  const config=JSON.parse(readFileSync(file,'utf8'));
  expect(config.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
  expect(config.hooks.Stop).toEqual(existing.hooks.Stop);expect(config.permissions).toEqual(existing.permissions);
  const hook=config.hooks.SessionStart[1].hooks[0];
  expect(hook.statusMessage).toBe(startupMarker);expect(hook.async).toBeUndefined();expect(hook.timeout).toBe(7);
  if(process.platform!=='win32')expect(statSync(file).mode&0o777).toBe(0o640);
  const before=readFileSync(file,'utf8'), mtime=statSync(file).mtimeMs;
  expect(startupHooks(['claude-code'],'install',options)[0]!.status).toBe('unchanged');
  expect(readFileSync(file,'utf8')).toBe(before);expect(statSync(file).mtimeMs).toBe(mtime);
  const codex=join(home,'.codex');mkdirSync(codex);writeFileSync(join(codex,'config.toml'),'[features]\nhooks = false\n');
  expect(startupHooks(['codex'],'install',options)[0]!.status).toBe('disabled');expect(existsSync(join(codex,'hooks.json'))).toBe(false);
  writeFileSync(file,JSON.stringify({disableAllHooks:true}));
  expect(startupHooks(['claude-code'],'install',options)[0]!.status).toBe('disabled');
}));

test('real startup CLI and board server preserve the agent-chosen profile across native lifecycle events',()=>fixture(async home=>{
  const env={...process.env,HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude'),OPENCRAWL_TOKEN:'disposable-board-test-token'};
  const server=Bun.spawn(['node',resolve(import.meta.dir,'fixtures/board-server.mjs'),join(home,'board.sqlite')],{env,stdout:'pipe',stderr:'pipe'});
  try {
    const reader=server.stdout.getReader(), first=await reader.read();
    if(first.done)throw new Error(await new Response(server.stderr).text());
    const {api}=JSON.parse(new TextDecoder().decode(first.value));reader.releaseLock();
    const run=async(args:string[],input?:unknown)=>{
      const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),...args,'--api',api],{env,stdin:input===undefined?'ignore':new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});
      const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      expect(code).toBe(0);expect(err).toBe('');return JSON.parse(out);
    };
    const start=(source:string,session='native-123',harness='codex')=>run(['session','start','--harness',harness],{...event,source,session_id:session});
    expect((await start('startup')).hookSpecificOutput.additionalContext).toContain('registered with');
    await run(['board','profile','--session','native-123','--name','codex:agent-choice','--task','Test real lifecycle','--json']);
    for(const source of ['resume','compact'])expect((await start(source)).hookSpecificOutput.additionalContext).toContain('codex:agent-choice');
    expect((await start('fork','native-fork')).hookSpecificOutput.additionalContext).toContain('Choose your own display name');
    expect((await start('startup','claude-native','claude-code')).hookSpecificOutput.additionalContext).toContain('registered with');
    expect(existsSync(join(home,'config/opencrawl/capture'))).toBe(false);
    expect(existsSync(join(home,'config/opencrawl/update.json'))).toBe(false);
    const invalid=await run(['session','start','--harness','codex'],{...event,session_id:'invalid\nsecret'});
    expect(invalid.hookSpecificOutput.additionalContext).toContain('unavailable');
    expect(JSON.stringify(invalid)).not.toContain('secret');
  } finally {server.kill();await server.exited;}
}),20_000);
