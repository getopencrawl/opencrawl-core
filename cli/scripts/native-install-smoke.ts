// Run the published installer shape and generated hooks with no Node/npm/Bun
// command available. The parent test harness serves only these built artifacts.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(import.meta.dir,'..'),pkg=JSON.parse(readFileSync(join(root,'dist/cli/package.json'),'utf8'));
const scratch=mkdtempSync(join(tmpdir(),'opencrawl-native-smoke-'));
const systemBin=join(scratch,'system-bin');mkdirSync(systemBin);
const env={...process.env,HOME:scratch,USERPROFILE:scratch,OPENCRAWL_CONFIG_HOME:join(scratch,'config'),XDG_CONFIG_HOME:join(scratch,'config'),XDG_CACHE_HOME:join(scratch,'cache'),XDG_DATA_HOME:join(scratch,'data'),OPENCRAWL_INSTALL_DIR:join(scratch,'bin'),CLAUDE_CONFIG_DIR:join(scratch,'claude'),CODEX_HOME:join(scratch,'codex'),OPENCRAWL_NO_UPDATE:'1',PATH:systemBin};
if(process.platform==='win32')env.PATH=join(process.env.SystemRoot||'C:\\Windows','System32');
else for(const name of ['sh','curl','uname','sed','grep','awk','sha256sum','shasum','mktemp','rm','tar','chmod','sysctl','ldd']){const file=Bun.which(name);if(file)symlinkSync(file,join(systemBin,name));}
async function run(command:string[],extra:Record<string,string>={}){const child=Bun.spawn(command,{env:{...env,...extra},stdout:'pipe',stderr:'pipe'});const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error('Native smoke failed: '+err+out);return out.trim();}
let corrupt=false;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const name=new URL(request.url).pathname.slice(1);if(!/^(SHA256SUMS|opencrawl-(darwin|linux|win32)-(arm64|x64)\.tgz)$/.test(name))return new Response('',{status:404});if(corrupt&&name.endsWith('.tgz'))return new Response('corrupted download');return new Response(Bun.file(join(root,'native',name)));}});
try{
  const windows=process.platform==='win32',powershell=windows?join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):'';
  const installer=windows?[powershell,'-NoProfile','-File',join(root,'install.ps1'),pkg.version]:['/bin/sh',join(root,'install.sh'),pkg.version];
  await run(installer,{OPENCRAWL_DOWNLOAD_BASE:server.url.origin});
  const entry=join(env.OPENCRAWL_INSTALL_DIR,windows?'opencrawl.cmd':'opencrawl');
  const command=(args:string[])=>windows?[powershell,'-NoProfile','-Command',`& '${entry.replace(/'/g,"''")}' ${args.map(v=>"'"+v.replace(/'/g,"''")+"'").join(' ')}`]:[entry,...args];
  if(await run(command(['--version']))!==pkg.version)throw new Error('Native install version mismatch');
  await run(command(['skills','install','--client','claude-code','--json']));
  const settings=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  const startup=settings.hooks.SessionStart.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl session startup');
  if(!startup||startup.command.includes('node')||startup.command.includes('runner.cjs'))throw new Error('Startup hook still needs Node');
  // A missing credential gives a bounded unavailable receipt, not an execution failure.
  const hook=windows?[powershell,'-NoProfile','-Command','& '+startup.command]:['/bin/sh','-c',startup.command];
  const child=Bun.spawn(hook,{env,stdin:new Blob([JSON.stringify({hook_event_name:'SessionStart',session_id:'native-smoke'})]),stdout:'pipe',stderr:'pipe'});
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  if(code||!out.includes('OpenCrawl'))throw new Error('Native startup hook failed: '+err+out);
  await run(command(['collect','install','--yes','--defer-auth','--backfill','skip','--harness','claude-code','--json']));
  const capture=JSON.parse(readFileSync(join(env.OPENCRAWL_CONFIG_HOME,'opencrawl/capture/config.json'),'utf8'));
  if(capture.command.length!==1||capture.command[0]!==entry)throw new Error('Capture did not use the durable native command');
  const configured=JSON.parse(readFileSync(join(env.CLAUDE_CONFIG_DIR,'settings.json'),'utf8'));
  const stop=configured.hooks.Stop.flatMap((g:any)=>g.hooks).find((h:any)=>h.statusMessage==='OpenCrawl session capture');
  if(!stop||stop.command.includes('node')||stop.command.includes('runner.cjs'))throw new Error('Capture hook still needs Node');
  const captureHook=windows?[powershell,'-NoProfile','-Command','& '+stop.command]:['/bin/sh','-c',stop.command];
  const collector=Bun.spawn(captureHook,{env,stdin:new Blob([JSON.stringify({hook_event_name:'Stop',session_id:'native-smoke'})]),stdout:'pipe',stderr:'pipe'});
  const [captureOut,captureErr,captureCode]=await Promise.all([new Response(collector.stdout).text(),new Response(collector.stderr).text(),collector.exited]);
  if(captureCode)throw new Error('Native capture hook failed: '+captureErr+captureOut);
  corrupt=true;
  let rejected=false;try{await run(installer,{OPENCRAWL_DOWNLOAD_BASE:server.url.origin});}catch(error){if(!String(error).includes('checksum mismatch'))throw error;rejected=true;}
  if(!rejected||await run(command(['--version']))!==pkg.version)throw new Error('Corrupted download was accepted or damaged the active version');
  console.log('Native installer, versioned launcher, skills and capture setup run without Node/npm/Bun on PATH.');
}finally{server.stop(true);rmSync(scratch,{recursive:true,force:true});}
