import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pluginHookFiles,type PluginHookBinding} from '../src/setup/plugin-hooks.ts';
import type {PluginClient} from '../src/setup/plugins.ts';

const clients:PluginClient[]=['codex','claude-code','cursor','antigravity'];
const binding:PluginHookBinding={command:['/private/selected CLI/opencrawl'],configHome:'/private/selected profile',api:'https://selected.example',pluginName:'opencrawl-123456abcdef'};
type Hook={command:string;timeout:number;async?:boolean;shell?:string};
function entries(client:PluginClient,files:Record<string,string>):Record<string,Hook[]>{
 const value=JSON.parse(files[client==='antigravity'?'hooks.json':'hooks/hooks.json']!);
 if(client==='antigravity'){
  const out:Record<string,Hook[]>={};
  for(const group of Object.values(value) as Record<string,{hooks?:Hook[]}[]>[])for(const [event,rows] of Object.entries(group))out[event]=[...(out[event]??[]),...rows.flatMap(row=>row.hooks??[row as Hook])];
  return out;
 }
 return Object.fromEntries(Object.entries(value.hooks).map(([event,rows])=>[event,(rows as {hooks?:Hook[]}[]).flatMap(row=>row.hooks??[row as Hook])]));
}

test('installation preserves canonical hook bytes across endpoints and profiles',()=>{
 for(const client of clients)for(const platform of ['linux','win32'] as const){
  const selected=platform==='win32'?{...binding,command:['C:\\CLI\\opencrawl.exe'],configHome:'C:\\profile'}:binding;
  const files=pluginHookFiles(client,selected,platform),other=pluginHookFiles(client,{...selected,api:'https://other.example',pluginName:'opencrawl-fedcba654321'},platform);
  const path=client==='antigravity'?'hooks.json':'hooks/hooks.json';
  expect(files[path]).toBe(readFileSync(join(import.meta.dir,'../../plugins/opencrawl-sessions',client,platform==='win32'?'windows':'posix',path),'utf8'));
  expect(files[path]).toBe(other[path]);expect(files['scripts/opencrawl-hook.sh']).toBe(other['scripts/opencrawl-hook.sh']);
  expect(files[path]).not.toContain(selected.api);expect(files['.opencrawl-binding.json']).toContain(selected.api);
  const hooks=entries(client,files),start=hooks[client==='cursor'?'sessionStart':'SessionStart'];
  expect(start).toHaveLength(2);expect(start[0]!.command).toEndWith(' start');expect(start[0]!.timeout).toBe(7);expect(start[0]!.async).toBeUndefined();
  const suggestions=Object.values(hooks).flat().filter(row=>row.command.endsWith(' suggest'));
  expect(suggestions).toHaveLength(client==='cursor'?3:1);
  for(const hook of suggestions){expect(hook.async).toBe(client==='codex'||client==='claude-code'?true:undefined);expect(hook.timeout).toBe(client==='codex'||client==='claude-code'?45:3);}
  if(client==='codex'){expect(hooks.SessionEnd![0]!.async).toBeUndefined();expect(hooks.SessionEnd![0]!.timeout).toBe(3);}
 }
});

test('canonical runner preserves literal command arguments and stdin without Node or Bun on PATH',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'opencrawl-plugin-hooks-')),home=realpathSync(temporary),windows=process.platform==='win32';
 try{
  const root=join(home,windows?'cache & %value%':'cache \' $value $(false)'),stub=join(home,'CLI source with spaces.ts');
  writeFileSync(stub,"console.log(JSON.stringify({args:process.argv.slice(2),input:await Bun.stdin.text()}));\n");
  const payload=JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'fixture'});
  for(const client of clients){
   const files=pluginHookFiles(client,{...binding,command:[process.execPath,stub,'literal & $value $(false)'],configHome:join(home,'profile')});
   for(const [name,text] of Object.entries(files)){const file=join(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);}
   const hook=Object.values(entries(client,files)).flat().find(row=>row.command.endsWith(' suggest'))!;
   const env={...process.env,PATH:windows?process.env.PATH:'/no-node-or-bun-on-path',PLUGIN_ROOT:root,CLAUDE_PLUGIN_ROOT:root,CURSOR_PLUGIN_ROOT:root};
   const executable=windows?(client==='codex'||hook.shell==='powershell'?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):process.env.ComSpec||'cmd.exe'):'/bin/sh';
   const args=windows?(client==='codex'||hook.shell==='powershell'?['-NoProfile','-NonInteractive','-Command',hook.command]:['/d','/s','/c','"'+hook.command+'"']):['-c',hook.command];
   const result=spawnSync(executable,args,{cwd:client==='antigravity'?root:home,env,input:payload,encoding:'utf8',timeout:10000,windowsVerbatimArguments:windows&&client!=='codex'&&hook.shell!=='powershell'});
   expect({error:result.error?.message,stderr:result.stderr,status:result.status}).toEqual({error:undefined,stderr:'',status:0});
   expect(JSON.parse(result.stdout)).toEqual({input:payload,args:['literal & $value $(false)','plugin-hook','--root',root,'--action','suggest']});
  }
 }finally{rmSync(temporary,{recursive:true,force:true});}
});

test('unsafe or unpinned configuration fails before native installation',()=>{
 for(const changed of [{command:['opencrawl']},{configHome:'relative'},{pluginName:'../other'},{command:['/selected/opencrawl\nmalicious']},{api:'https://selected.example/path'},{api:'https://secret:token@selected.example'}])
  expect(()=>pluginHookFiles('codex',{...binding,...changed},'linux')).toThrow();
});
