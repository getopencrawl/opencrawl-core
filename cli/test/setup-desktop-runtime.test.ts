import {expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopExecutables} from '../src/setup/desktop-runtime.ts';
import {canInstallRecordingPlugin,pluginInventory,recordingRuntime} from '../src/setup/plugins.ts';

const executable=(path:string)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'fixture',{mode:0o755});};
test.skipIf(process.platform==='win32')('desktop-only discovery requires a local app, finds initialized Code, and falls back from an outdated PATH client',async()=>{
 const home=mkdtempSync(join(tmpdir(),'oc-desktop-')),apps=join(home,'apps');
 const options={home,applicationDirs:[apps],env:{},which:()=>null};
 try{
  for(const platform of ['darwin','linux'] as const){
   const mac=platform==='darwin',data=mac?join(home,'Library/Application Support'):join(home,'.config');
   const engine=join(data,'Claude/claude-code/2.1.330/4262a1273231',mac?'claude.app/Contents/MacOS/claude':'claude');
   executable(engine);
   expect(desktopExecutables('claude-code',{...options,platform})).toEqual([]);
   executable(join(apps,mac?'Claude.app/Contents/MacOS/Claude':'claude-desktop/claude-desktop'));
   expect(await recordingRuntime('claude-code',{...options,runner:async()=>({code:0,stdout:'2.1.330 (Claude Code)'})},platform)).toEqual({executable:engine,desktop:true});
  }
  for(const platform of ['darwin','linux'] as const){
   const bundled=join(apps,platform==='darwin'?'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex':'chatgpt/resources/codex');
   executable(bundled);
   const runner=async(command:string)=>({code:0,stdout:command===bundled?'codex-cli 0.171.0-alpha.13':'codex-cli 0.100.0'});
   for(const terminal of [null,'/older/codex'])expect(await recordingRuntime('codex',{...options,which:()=>terminal,runner},platform)).toEqual({executable:bundled,desktop:true});
  }
 }finally{rmSync(home,{force:true,recursive:true});}
});

test.skipIf(process.platform==='win32')('Cursor editor eligibility uses its native product and version independently of cursor-agent',async()=>{
 const home=mkdtempSync(join(tmpdir(),'oc-cursor-editor-')),apps=join(home,'apps');
 try{
  for(const platform of ['darwin','linux'] as const){
   const mac=platform==='darwin',root=join(apps,mac?'Cursor.app/Contents':'cursor');
   const app=join(root,mac?'MacOS/Cursor':'cursor'),resources=join(root,mac?'Resources/app':'resources/app');
   const options={home,applicationDirs:[apps],env:{PATH:home},runner:async()=>{throw Error('Editor discovery must not launch Cursor');}};
   mkdirSync(resources,{recursive:true});
   const manifest=(applicationName:string,version:string)=>writeFileSync(join(resources,'product.json'),JSON.stringify({applicationName,version}));
   manifest('cursor','3.18.9');
   expect(await recordingRuntime('cursor',options,platform)).toBeUndefined();
   executable(app);
   manifest('code','3.18.9');
   expect(await recordingRuntime('cursor',options,platform)).toBeUndefined();
   manifest('cursor','2.4.99');
   expect(await recordingRuntime('cursor',options,platform)).toBeUndefined();
   manifest('cursor','3.18.9');
   expect(pluginInventory(options,platform).find(row=>row.id==='cursor')?.detected).toBe(true);
   expect(await canInstallRecordingPlugin('cursor',options,platform)).toBe(true);
   const launcher=join(resources,'bin/cursor'),link=join(home,platform,'cursor');
   executable(launcher);mkdirSync(dirname(link));symlinkSync(launcher,link);
   expect(await recordingRuntime('cursor',{...options,applicationDirs:[],env:{PATH:dirname(link)}},platform)).toEqual({executable:realpathSync(app),desktop:true});
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

test.skipIf(process.platform==='win32')('Antigravity resolves the user install with a restricted PATH and falls back past an outdated PATH binary',async()=>{
 const home=mkdtempSync(join(tmpdir(),'oc-agy-')),old=join(home,'older/bin'),installed=join(home,'.local/bin/agy');
 const script=(path:string,version:string)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'#!/bin/sh\n[ "$1" = "--version" ] || exit 1\necho '+version+'\n',{mode:0o755});};
 try{
  for(const platform of ['darwin','linux'] as const){
   const options={home,applicationDirs:[],env:{PATH:old}};
   script(join(old,'agy'),'1.0.0');script(installed,'1.5.14');
   expect(await recordingRuntime('antigravity',options,platform)).toEqual({executable:installed,desktop:false});
   const restricted={...options,env:{PATH:join(home,'empty')}};
   expect(await canInstallRecordingPlugin('antigravity',restricted,platform)).toBe(true);
   expect(pluginInventory(restricted,platform).find(row=>row.id==='antigravity')?.detected).toBe(true);
   chmodSync(installed,0o644);
   expect(await canInstallRecordingPlugin('antigravity',restricted,platform)).toBe(false);
   rmSync(installed);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});
