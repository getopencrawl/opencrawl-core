import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pluginHookFiles,type PluginHookBinding} from '../src/setup/plugin-hooks.ts';
import type {PluginClient} from '../src/setup/plugins.ts';

const clients:PluginClient[]=['codex','claude-code','cursor','antigravity'];
const binding:PluginHookBinding={command:['/private/selected CLI/opencrawl'],configHome:'/private/selected profile',api:'https://selected.example',pluginName:'opencrawl-123456abcdef'};
type Hook={command:string;timeout:number;async?:boolean;statusMessage?:string;shell?:string};
function entries(client:PluginClient,files:Record<string,string>):Record<string,Hook[]>{
 const value=JSON.parse(files[client==='antigravity'?'hooks.json':'hooks/hooks.json']);
 if(client==='antigravity'){
  const out:Record<string,Hook[]>={};
  for(const group of Object.values(value) as Record<string,any>[])for(const [event,rows] of Object.entries(group))out[event]=[...(out[event]??[]),...rows.flatMap((row:any)=>row.hooks??[row])];
  return out;
 }
 return Object.fromEntries(Object.entries(value.hooks).map(([event,rows])=>[event,(rows as any[]).flatMap(row=>row.hooks??[row])]));
}

test('all four native plugin formats include synchronous startup and supported capture delivery',()=>{
 for(const client of clients){
  const files=pluginHookFiles(client,binding,'linux'),hooks=entries(client,files);
  expect(Object.keys(files).sort()).toEqual([client==='antigravity'?'hooks.json':'hooks/hooks.json','scripts/opencrawl-hook.sh'].sort());
  const start=hooks[client==='cursor'?'sessionStart':'SessionStart'];
  expect(start).toHaveLength(2);expect(start[0].command).toContain('session start --harness '+client);expect(start[0].timeout).toBe(7);expect(start[0].async).toBeUndefined();
  expect(start[1].command).toContain('collect hook');
  for(const hook of Object.values(hooks).flat())expect(hook.command).toContain('--api https://selected.example');
  if(client==='codex'){
   expect(hooks.SessionEnd[0].async).toBeUndefined();expect(hooks.SessionEnd[0].timeout).toBe(3);expect(hooks.SessionEnd[0].command).not.toContain('--managed');
   expect(hooks.PostToolUse[0].async).toBe(true);expect(hooks.PostToolUse[0].command).not.toContain('--managed');
  }else if(client==='claude-code'){expect(Object.keys(hooks).sort()).toEqual(['PreToolUse','SessionEnd','SessionStart','Stop','UserPromptSubmit']);expect(hooks.SessionEnd[0]).toMatchObject({async:true,timeout:120});expect(start[1].command).not.toContain('--managed');}
  else if(client==='cursor'){
   expect(JSON.parse(files['hooks/hooks.json']).version).toBe(1);
   expect(hooks.stop[0].command).toContain('$CURSOR_PLUGIN_ROOT/');expect(hooks.postToolUseFailure).toHaveLength(1);expect(hooks.preCompact).toHaveLength(1);
   expect(hooks.postToolUse).toHaveLength(2);expect(hooks.postToolUse[0].command).toBe(start[0].command+' --after-tool');
   expect(hooks.postToolUse[0].timeout).toBe(7);expect(hooks.postToolUse[0].async).toBeUndefined();expect(hooks.postToolUse[1].command).toContain('collect hook');
  }
  else for(const [event,rows] of Object.entries(hooks))if(event!=='PreToolUse')expect(rows.at(-1)!.command).toContain('--event '+event);
  const search=hooks[client==='cursor'?'preToolUse':'PreToolUse'].find(hook=>hook.command.includes('search-context'))!;
  expect(search).toBeDefined();expect(search.timeout).toBe(2);expect(search.async).toBeUndefined();
  expect(search.command).toContain('search-context --harness '+client);
 }
});

test('bundled runners retain stdin, argv and profile binding after a cache move with unrelated ambient settings',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'opencrawl-plugin-hooks-')),home=realpathSync(temporary),windows=process.platform==='win32';
 try{
  const root=join(home,windows?'cache space & %value%':'cache space \' $value $(false)'),profile=join(home,windows?'selected profile & %value%':'selected profile \' $value $(false)'),stub=join(home,'CLI source with spaces.ts');
  writeFileSync(stub,"console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2),input:await Bun.stdin.text(),profile:process.env.OPENCRAWL_CONFIG_HOME,api:process.env.OPENCRAWL_PLUGIN_API,name:process.env.OPENCRAWL_PLUGIN_NAME,client:process.env.OPENCRAWL_PLUGIN_CLIENT,root:process.env.OPENCRAWL_PLUGIN_ROOT,token:process.env.OPENCRAWL_TOKEN??null,sessionsToken:process.env.OPENCRAWL_SESSIONS_TOKEN??null,authMode:process.env.OPENCRAWL_AUTH??null,ambientApi:process.env.OPENCRAWL_API_URL??null}));\n");
  const payload=JSON.stringify({hook_event_name:'SessionStart',session_id:'fixture',cwd:'/not-the-plugin'});
  for(const client of clients){
   const files=pluginHookFiles(client,{...binding,command:[process.execPath,stub,'pinned launcher argument'],configHome:profile});
   for(const [name,text] of Object.entries(files)){const file=join(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
   const start=entries(client,files)[client==='cursor'?'sessionStart':'SessionStart'];
   const callbacks=client==='cursor'?[...start,entries(client,files).postToolUse[0]]:start;
   for(const hook of callbacks){
    const env={...process.env,PATH:windows?process.env.PATH:'/no-node-or-bun-on-path',OPENCRAWL_TOKEN:'fixture-ambient-user-token',OPENCRAWL_SESSIONS_TOKEN:'fixture-ambient-capture-token',OPENCRAWL_AUTH:'replicas-workspace',OPENCRAWL_API_URL:'https://unrelated.example',OPENCRAWL_CONFIG_HOME:'/unrelated/profile',OPENCRAWL_PLUGIN_API:'https://unrelated.example',OPENCRAWL_PLUGIN_ROOT:'/unrelated/cache',PLUGIN_ROOT:root,CLAUDE_PLUGIN_ROOT:root,CURSOR_PLUGIN_ROOT:root};
    const executable=windows?(client==='codex'||hook.shell==='powershell'?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):process.env.ComSpec||'cmd.exe'):'/bin/sh';
    const args=windows?(client==='codex'||hook.shell==='powershell'?['-NoProfile','-NonInteractive','-Command',hook.command]:['/d','/s','/c','"'+hook.command+'"']):['-c',hook.command];
    // cmd.exe consumes the already quoted /c string; C-runtime argv escaping corrupts it.
    const result=spawnSync(executable,args,{cwd:client==='antigravity'?root:home,env,input:payload,encoding:'utf8',timeout:10_000,windowsVerbatimArguments:windows&&client!=='codex'&&hook.shell!=='powershell'});
    expect({error:result.error?.message,stderr:result.stderr,status:result.status}).toEqual({error:undefined,stderr:'',status:0});
    const observed=JSON.parse(result.stdout);
    if(!windows&&client==='claude-code'&&hook===start[1]){
     const direct=spawnSync('/bin/sh',[join(root,'scripts/opencrawl-hook.sh'),'collect','hook','--harness',client],{cwd:root,env,input:payload,encoding:'utf8',timeout:10_000});
     expect(direct.status).toBe(0);expect(JSON.parse(direct.stdout).pid).toBe(direct.pid);
    }
    expect(observed).toMatchObject({input:payload,profile,api:binding.api,name:binding.pluginName,client,root,token:null,sessionsToken:null,authMode:null,ambientApi:null});
    expect(env.OPENCRAWL_TOKEN).toBe('fixture-ambient-user-token');expect(env.OPENCRAWL_SESSIONS_TOKEN).toBe('fixture-ambient-capture-token');expect(env.OPENCRAWL_AUTH).toBe('replicas-workspace');
    expect(observed.args[0]).toBe('pinned launcher argument');expect(observed.args.slice(1,3)).toEqual(hook===start[1]?['collect','hook']:['session','start']);
    if(client==='cursor'&&hook===callbacks.at(-1))expect(observed.args).toContain('--after-tool');
    expect(observed.args.slice(observed.args.indexOf('--harness'),observed.args.indexOf('--harness')+2)).toEqual(['--harness',client]);
   }
  }
 }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('Windows bundles use native command shells and protect profile percent and delayed-expansion characters',()=>{
 for(const client of clients){
  const files=pluginHookFiles(client,{...binding,command:['C:\\managed CLI\\opencrawl.cmd'],configHome:'C:\\profile %TEMP% !keep!'},'win32');
  expect(files['scripts/opencrawl-hook.cmd']).toContain('setlocal DisableDelayedExpansion');
  for(const name of ['OPENCRAWL_TOKEN','OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_AUTH','OPENCRAWL_API_URL'])expect(files['scripts/opencrawl-hook.cmd']).toContain('set "'+name+'="');
  expect(files['scripts/opencrawl-hook.cmd']).toContain('OPENCRAWL_CONFIG_HOME=C:\\profile %%TEMP%% !keep!');
  expect(files['scripts/opencrawl-hook.cmd']).toContain('OPENCRAWL_PLUGIN_ROOT=%%~fI');
  const first=entries(client,files)[client==='cursor'?'sessionStart':'SessionStart'][0];
  if(client==='claude-code'||client==='codex'){expect(first.shell).toBe(client==='claude-code'?'powershell':undefined);expect(first.command).toContain('$env:'+(client==='codex'?'PLUGIN_ROOT':'CLAUDE_PLUGIN_ROOT'));}
  else if(client==='antigravity')expect(first.command).toStartWith('".\\scripts\\opencrawl-hook.cmd"');
  else {expect(JSON.parse(files['hooks/hooks.json']).version).toBe(1);expect(first.command).toContain('%CURSOR_PLUGIN_ROOT%');}
 }
});

test('unsafe or unpinned bindings fail before any native configuration can be produced',()=>{
 for(const changed of [{command:['opencrawl']},{configHome:'relative'},{pluginName:'../other'},{command:['/selected/opencrawl\nmalicious']},{api:'https://selected.example/path'},{api:'https://secret:token@selected.example'}])
  expect(()=>pluginHookFiles('codex',{...binding,...changed},'linux')).toThrow();
 expect(()=>pluginHookFiles('codex',{...binding,command:['C:\\CLI"malicious.exe'],configHome:'C:\\profile'},'win32')).toThrow();
});
