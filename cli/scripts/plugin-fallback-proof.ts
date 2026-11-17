/** Real plugin-hook delivery with a healthy synthetic receiver. Claude Code and
 * Codex run the repository plugin's own files; Cursor runs its generated hooks.
 * Native client admission is fixture-owned; callers separately verify desktop
 * trust and MCP. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,cpSync,chmodSync} from 'node:fs';
import {join,dirname,delimiter} from 'node:path';
import {installSetupPlugins} from '../src/setup/plugins.ts';
import {captureDir,readCaptureConfig,type CaptureConfig} from '../src/capture/runtime.ts';
const shellQuote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
export async function prepareFallbackPlugins(command:string[],config:CaptureConfig,root:string){
 const pluginRoots=new Map<string,string>();
    const plugins=await installSetupPlugins(config.api,['cursor'],{home:root,command,which:()=>null});
    for(const row of plugins.results){assert(row.directory);pluginRoots.set(row.client,row.directory);}
    // The repository plugin finds the CLI on PATH, so the fixture provides the
    // CLI under test there instead of a marketplace install.
    const launcher=join(root,'sessions-plugins/bin/opencrawl');mkdirSync(dirname(launcher),{recursive:true});
    writeFileSync(launcher,'#!/bin/sh\nexec '+command.map(shellQuote).join(' ')+' "$@"\n');chmodSync(launcher,0o755);
    for(const client of ['claude-code','codex']){
      const directory=join(root,'sessions-plugins',client);cpSync(join(import.meta.dir,'../../plugins/opencrawl-sessions',client),directory,{recursive:true});pluginRoots.set(client,directory);
    }
 return pluginRoots;
}
export async function proveOnlinePluginFallback(config:CaptureConfig,pluginRoots:Map<string,string>,batches:unknown[]){
 const until=async(check:()=>boolean,ms:number)=>{const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('Plugin fallback hooks did not upload final answers');await Bun.sleep(50);}};
    const children:ReturnType<typeof Bun.spawn>[]=[],outputs:Promise<string>[]=[];
    try{
      for(const harness of ['claude-code','codex','cursor'] as const){
        const text='healthy fallback final answer '+harness,session='fallback-'+harness;
        let payload:Record<string,unknown>;
        if(harness==='cursor')payload={conversation_id:session,hook_event_name:'afterAgentResponse',text};
        else {
          const path=join(config.roots[harness],harness==='claude-code'?'projects/fixture':'sessions',harness==='claude-code'?session+'.jsonl':'rollout-'+session+'.jsonl');mkdirSync(dirname(path),{recursive:true});
          const records=harness==='claude-code'?[{type:'assistant',sessionId:session,uuid:session,message:{role:'assistant',content:[{type:'text',text}]}}]:[{type:'session_meta',payload:{id:session}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}}];
          writeFileSync(path,records.map(row=>JSON.stringify(row)).join('\n')+'\n');payload={session_id:session,hook_event_name:'Stop',transcript_path:path};
        }
        const directory=pluginRoots.get(harness)!,hooks=JSON.parse(readFileSync(harness==='cursor'?join(config.roots.cursor!,'hooks.json'):join(directory,'hooks/hooks.json'),'utf8')).hooks;
        const entries=hooks[harness==='cursor'?'afterAgentResponse':'Stop'].flatMap((row:any)=>row.hooks??[row]);
        const hook=entries.find((row:any)=>row.command.includes('collect hook'));assert(hook);if(harness!=='cursor')assert.equal(hook.async,true);
        const env={...process.env,CLAUDE_PLUGIN_ROOT:directory,PLUGIN_ROOT:directory,CURSOR_PLUGIN_ROOT:directory,...(harness==='cursor'?{}:{PATH:join(dirname(directory),'bin')+delimiter+(process.env.PATH??'')})};
        const child=Bun.spawn(['/bin/sh','-c','exec '+hook.command],{env,stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});children.push(child);outputs.push(new Response(child.stdout).text(),new Response(child.stderr).text());
        await until(()=>batches.some((batch:any)=>batch.harness===harness&&batch.events?.some((event:any)=>event.kind==='message'&&event.data?.role==='assistant'&&event.data.content?.some((part:any)=>part.type===(harness==='codex'?'output_text':'text')&&part.text===text))),25_000).catch(error=>{throw Error(harness+': '+error.message+'; received harnesses '+JSON.stringify(batches.map((batch:any)=>batch.harness))+'; local '+(existsSync(join(captureDir(),'last-error.json'))?readFileSync(join(captureDir(),'last-error.json'),'utf8'):'none'));});
        await until(()=>readdirSync(join(captureDir(),'queue')).every(name=>!name.endsWith('.json')),5000);
        assert(existsSync(join(captureDir(),'last-upload.json')));assert.deepEqual(readCaptureConfig(),config);assert(!existsSync(join(captureDir(),'daemon','service.json')));
        // End this fixture worker before creating the next client's transcript.
        // No other harness can drain its notice and mask a missing uploader.
        if(harness!=='cursor'&&child.exitCode===null)child.kill('SIGTERM');
        await child.exited;
      }
    }finally{for(const child of children)if(child.exitCode===null)child.kill();await Promise.all(children.map(child=>child.exited));}
}
