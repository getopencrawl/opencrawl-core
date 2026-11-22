import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopExecutables} from '../src/setup/desktop-runtime.ts';
import {recordingRuntime} from '../src/setup/plugins.ts';

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
