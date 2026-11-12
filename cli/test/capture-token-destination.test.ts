import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {standaloneCapture} from '../../dist/src/sessions/standalone.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {installCapture,uninstallCapture} from '../src/capture/install.ts';
import {captureStatus,readCaptureConfig} from '../src/capture/runtime.ts';

// An environment token is only sent to a deployment the invocation names (see
// environment-token.test.ts). A machine prepared without a sign-in gets its
// token later, as an environment secret, in hooks that are run with no
// arguments of the person's choosing: those hooks have to name the deployment
// themselves, or the documented cloud setup uploads nothing.
const token='token-destination-capture-token-0123456789';
/** Every hook entry in a harness file; none for a harness that is not installed. */
const hooks=(file:string):any[]=>existsSync(file)?Object.values(JSON.parse(readFileSync(file,'utf8')).hooks??{}).flat():[];
async function fixture(run:(f:any)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-token-destination-')),saved={...process.env};
  const principal={tenantId:'tenant-test',userId:'user-test',name:'Owner',email:'owner@example.com'};
  const store=createLocalSessionStore(join(dir,'objects')),ingest=createSessionIngest({store,onStored:undefined});
  const handler=standaloneCapture({token,principal,store,prefix:undefined,search:undefined}),batches:any[]=[];
  const server=createServer(async(req,res)=>{
    if(req.url==='/api/sessions/batches'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const batch=JSON.parse(Buffer.concat(chunks).toString());batches.push(batch);
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:await ingest.putBatch(principal,batch)}));return;
    }
    handler(req,res);
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const api='http://127.0.0.1:'+(server.address() as any).port;
  try {
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),OPENCRAWL_NO_UPDATE:'1'});
    // Nothing but the invocation may name a deployment or supply a token here.
    for(const key of ['OPENCRAWL_API_URL','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_TOKEN','CLAUDE_CODE_REMOTE'])delete process.env[key];
    await run({dir,api,principal,batches,install:(options:Record<string,unknown>={})=>installCapture(api,{home:dir,command:[process.execPath,'-e',''],...options}),
      commands:()=>({
        claude:hooks(join(dir,'claude','settings.json')).flatMap((group:any)=>group.hooks).map((hook:any)=>hook.command as string),
        codex:hooks(join(dir,'codex','hooks.json')).flatMap((group:any)=>group.hooks).map((hook:any)=>hook.command as string),
        grokBot:hooks(join(dir,'.cursor','hooks.json')).map((entry:any)=>entry.command as string)})});
  } finally {
    try{await uninstallCapture(dir);}catch{}
    server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
  }
}

test('an install without a sign-in writes the deployment it was told to use into every hook command',async()=>fixture(async f=>{
  const all=['claude-code','codex','grok-bot'],named=process.platform==='win32'?` --api "${f.api}"`:` --api '${f.api}'`;
  await f.install({deferAuth:true,namedApi:true,harnesses:all});
  expect(readCaptureConfig()).toMatchObject({authPending:true,hookApi:f.api});
  const commands=f.commands();
  expect(commands.claude).toHaveLength(8);expect(commands.codex).toHaveLength(7);expect(commands.grokBot).toHaveLength(9);
  for(const command of [...commands.claude,...commands.codex])expect(command.endsWith(named)).toBe(true);
  // Grok Bot's entry is not quoted where it need not be, so it survives being split on spaces.
  if(process.platform!=='win32')for(const command of commands.grokBot)expect(command.endsWith(' collect hook --harness grok-bot --api '+f.api)).toBe(true);
  // Repeating the preparation, or a later install that leaves the deployment unnamed, keeps it.
  await f.install({deferAuth:true,harnesses:all});
  expect(readCaptureConfig()!.hookApi).toBe(f.api);expect(f.commands()).toEqual(commands);
}));

test('hook commands name no deployment where the person signed in, or never named one',async()=>fixture(async f=>{
  const all=['claude-code','codex','grok-bot'];
  // Without a named deployment a default or saved server must not become the token's destination.
  await f.install({deferAuth:true,harnesses:all});
  expect(readCaptureConfig()!.hookApi).toBeUndefined();
  for(const command of Object.values(f.commands()).flat())expect(command).not.toContain('--api');
  await uninstallCapture(f.dir);
  // A signed-in install authenticates now and keeps its own credential: its hooks need nothing from the environment.
  Object.assign(process.env,{OPENCRAWL_SESSIONS_TOKEN:token,OPENCRAWL_API_URL:f.api});
  await f.install({namedApi:true,harnesses:all});
  expect(readCaptureConfig()).toMatchObject({owner:{userId:'user-test'}});expect(readCaptureConfig()!.hookApi).toBeUndefined();
  for(const command of Object.values(f.commands()).flat())expect(command).not.toContain('--api');
}));

test('a hook that names its deployment takes the token from the environment; one that does not still refuses it',async()=>fixture(async f=>{
  await f.install({deferAuth:true,namedApi:true,harnesses:['grok-bot']});
  const cli=resolve(import.meta.dir,'../src/cli.ts'),env:Record<string,string|undefined>={...process.env,OPENCRAWL_SESSIONS_TOKEN:token};
  const run=async(args:string[],event:any)=>{
    const child=Bun.spawn(['bun',cli,'collect','hook','--harness','grok-bot',...args],{stdin:Buffer.from(JSON.stringify(event)),stdout:'pipe',stderr:'pipe',env});
    const [exit,stdout]=await Promise.all([child.exited,new Response(child.stdout).text()]);
    return {exit,stdout};
  };
  const stop={hook_event_name:'stop',conversation_id:'bot-1',workspace_roots:['/home/bot/work'],status:'completed'};
  const prompt={hook_event_name:'beforeSubmitPrompt',conversation_id:'bot-1',workspace_roots:['/home/bot/work'],prompt:'recorded once a destination is named'};
  // As a hook written before this change runs: the token is in the environment and nothing says where it may go.
  expect(await run([],stop)).toEqual({exit:0,stdout:'{}\n'});
  expect(captureStatus()).toMatchObject({authenticationPending:true,owner:null,lastError:{code:'TOKEN_DESTINATION_REQUIRED'}});
  expect(f.batches).toHaveLength(0);
  // As the installed command runs it. The arguments come from that command.
  const installed=f.commands().grokBot[0],args=installed.slice(installed.indexOf('--api')).split(' ');
  expect(args).toEqual(['--api',f.api]);
  expect(await run(args,prompt)).toEqual({exit:0,stdout:'{"continue":true}\n'});
  expect(await run(args,stop)).toEqual({exit:0,stdout:'{}\n'});
  expect(captureStatus()).toMatchObject({authenticationPending:false,owner:{userId:'user-test'},pendingHooks:0,queued:0});
  expect(f.batches.flatMap((batch:any)=>batch.events).filter((event:any)=>event.kind==='message').map((event:any)=>event.data.content[0].text)).toEqual(['recorded once a destination is named']);
  // A deployment named in the environment that is not the hook's own is still a mismatch, not a second destination.
  env.OPENCRAWL_API_URL='https://elsewhere.example';
  expect(await run([],stop)).toEqual({exit:0,stdout:'{}\n'});
  expect(captureStatus().lastError).toMatchObject({code:'TOKEN_DESTINATION_MISMATCH'});
}),60_000);
