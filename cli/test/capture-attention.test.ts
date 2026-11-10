import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {installCapture} from '../src/capture/install.ts';
import {captureDir,captureStatus,captureAttention,captureAttentionNotice,recordError} from '../src/capture/runtime.ts';
import {CliError} from '../src/oauth.ts';

test('a revoked sign-in pauses capture visibly, once per hour, and clears after a later upload',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-capture-attention-')),saved={...process.env};
 try{
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex')});
  delete process.env.OPENCRAWL_SESSIONS_TOKEN;
  await installCapture('https://capture.example.com',{background:false,deferAuth:true,home:dir,command:[process.execPath,'-e','']});
  expect(captureAttention()).toBeNull();
  // Transient failures are retried silently; only sign-in loss needs the person.
  recordError(new CliError('CAPTURE_RETRY_EXHAUSTED','retry'));
  expect(captureAttention()).toBeNull();
  writeFileSync(join(captureDir(),'queue','batch.json'),'{}');
  recordError(new CliError('AUTH_REQUIRED','revoked',2));
  const message=captureAttention()!;
  expect(message).toContain('capture.example.com');
  expect(message).toContain('1 batch queued');
  expect(message).toContain('opencrawl login');
  expect(message).toContain('OPENCRAWL_SESSIONS_TOKEN');
  expect(captureStatus().attention).toBe(message);
  const now=Date.now();
  expect(captureAttentionNotice(now)).toBe(message);
  expect(captureAttentionNotice(now+60_000)).toBeNull();
  expect(captureAttentionNotice(now+3_600_000)).toBe(message);
  // The Claude Code hook emits the notice as async-hook JSON; other events stay silent.
  rmSync(join(captureDir(),'attention-shown.json'));
  const cli=resolve(import.meta.dir,'../src/cli.ts');
  const hook=async(event:any,harness='claude-code')=>{
   const child=Bun.spawn([process.execPath,cli,'collect','hook','--harness',harness],{env:process.env,stdin:new Blob([JSON.stringify({session_id:'session',cwd:dir,...event})]),stdout:'pipe',stderr:'pipe'});
   expect(await child.exited).toBe(0);return (await new Response(child.stdout).text()).trim();
  };
  expect(await hook({hook_event_name:'PreToolUse'})).toBe('');
  expect(await hook({hook_event_name:'SessionStart'},'codex')).toBe('');
  const output=JSON.parse(await hook({hook_event_name:'SessionStart'}));
  expect(output).toEqual({systemMessage:message,hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:message}});
  expect(await hook({hook_event_name:'UserPromptSubmit'})).toBe('');
  // A successful upload after the failure makes the recorded error stale.
  writeFileSync(join(captureDir(),'last-upload.json'),JSON.stringify({at:new Date(Date.now()+1000).toISOString(),stored:true}));
  expect(captureAttention()).toBeNull();
  expect(captureStatus().attention).toBeNull();
  expect(existsSync(join(captureDir(),'queue','batch.json'))).toBe(true);
 }finally{process.env=saved;rmSync(dir,{recursive:true,force:true});}
});
