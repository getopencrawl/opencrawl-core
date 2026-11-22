import {test,expect} from 'bun:test';
test('saved setup destination cannot redirect an environment token',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'oc-setup-token-'));let requests=0;
 const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>{requests++;return Response.json({});}});
 try{
  const config=join(home,'opencrawl','capture');mkdirSync(config,{recursive:true});
  writeFileSync(join(config,'config.json'),JSON.stringify({schemaVersion:1,api:server.url.origin,owner:{tenantId:'fixture',userId:'fixture'},installationId:'fixture',harnesses:[],roots:{'claude-code':join(home,'claude'),codex:join(home,'codex')}}));
  const env:NodeJS.ProcessEnv={...process.env,OPENCRAWL_CONFIG_HOME:home,OPENCRAWL_TOKEN:'fixture-token',OPENCRAWL_NO_UPDATE:'1'};delete env.OPENCRAWL_API_URL;
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'setup','--json'],{env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const output=await new Response(child.stdout).text();const error=await new Response(child.stderr).text();
  expect(await child.exited).toBe(64);expect(output+error).toContain('TOKEN_DESTINATION_MISMATCH');expect(requests).toBe(0);
 }finally{server.stop(true);rmSync(home,{recursive:true,force:true});}
});

test.skipIf(process.platform==='win32')('explicit setup ignores old navigation and waits for a recording choice with no agents on PATH',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const home=mkdtempSync(join(tmpdir(),'oc-fresh-setup-'));
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>Response.json({schemaVersion:1,data:{scope:{tenantId:'tenant',userId:'user'},installations:[]}})});
 const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,PATH:home,OPENCRAWL_CONFIG_HOME:home,OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_TOKEN:'fixture-access-token-0123456789',TERM:'xterm-256color',FORCE_COLOR:'0'};
 delete env.OPENCRAWL_API_URL;
 const setup=join(home,'opencrawl','setup');
 mkdirSync(setup,{recursive:true});writeFileSync(join(setup,'interactive.json'),JSON.stringify({id:'old-run',api:'https://old.example.test'}));
 async function run(args:string[],steps:[string,string][]){
  let output='',index=0;
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'setup',...args],{env,terminal:{cols:120,rows:40,data(terminal,bytes){
   output+=new TextDecoder().decode(bytes);
   const step=steps[index];
   if(step&&output.includes(step[0])){index++;output='';setTimeout(()=>terminal.write(step[1]),60);}
  }}});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),6000);
  try{expect(await child.exited).toBe(0);expect(index).toBe(steps.length);}
  finally{clearTimeout(timeout);child.terminal?.close();}
 }
 try{
  await run([],[['› [ Continue ]','\r'],['Where is your workspace?','\x1b']]);
  await run(['--api',server.url.origin],[['› [ Continue ]','\r'],['Requires claude ',' '],['[x] Claude Code','\x1b']]);
 }finally{server.stop(true);rmSync(home,{recursive:true,force:true});}
},16000);
