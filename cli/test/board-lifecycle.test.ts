import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

const boardModule=resolve(import.meta.dir,'../src/board.ts');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean,ms=5000){
  const end=Date.now()+ms;
  while(!check()){if(Date.now()>end)throw new Error('Board lifecycle probe timed out');await pause(20);}
}

// The parent deliberately leaves the listener's log handle alive. A successful
// write to that handle must not make a dead chat consume new board messages.
for(const operation of ['watch','wait'])for(const mode of ['quiet','late-response','blocked'])test(`${operation} stops after its parent exits (${mode})`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'board-lifecycle-'));
  const receipt='f'.repeat(64),requests:string[]=[];let acknowledgments=0,deliver=false,unblock:(()=>void)|undefined;
  const response=()=>Response.json({schemaVersion:1,data:{batch:deliver?{receipt,messages:[{id:1,text:'must reach the replacement'}]}:null,pollAfterMs:30_000}});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const path=new URL(req.url).pathname;requests.push(path);
    if(path.endsWith('/ack')){acknowledgments++;return Response.json({schemaVersion:1,data:{}});}
    if(mode!=='quiet'&&requests.length===1)await new Promise<void>(resolve=>{unblock=resolve;});
    return response();
  }});
  const api=`http://127.0.0.1:${server.port}`;
  const env={...process.env,OPENCRAWL_CONFIG_HOME:root,OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'disposable-board-lifecycle-token',OPENCRAWL_NO_UPDATE:'1'};
  const stopped=join(root,'stopped'),pidFile=join(root,'pid'),output=join(root,'output');
  const watcher=join(root,'watcher.ts');
  writeFileSync(watcher,`import {boardCommand,writeBoardOutput} from ${JSON.stringify(boardModule)};import {writeFileSync} from 'node:fs';
    try{await boardCommand(${JSON.stringify(operation)},${JSON.stringify(api)},{session:'lifecycle'},d=>writeBoardOutput(d,true));}
    finally{writeFileSync(${JSON.stringify(stopped)},'stopped');}`);
  const parentCode=`import{spawn}from'node:child_process';import{openSync,writeFileSync}from'node:fs';
    const fd=openSync(${JSON.stringify(output)},'a');
    const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(watcher)}],{env:process.env,stdio:['ignore',fd,fd]});
    writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const parent=Bun.spawn([process.execPath,'-e',parentCode],{env,stdout:'ignore',stderr:'pipe'});
  let pid:number|undefined;
  try{
    await until(()=>existsSync(pidFile));pid=Number(readFileSync(pidFile,'utf8'));
    await until(()=>requests.length>0);
    expect(existsSync(stopped)).toBe(false);
    const duplicate=Bun.spawn([process.execPath,'-e',`import{boardCommand}from ${JSON.stringify(boardModule)};try{await boardCommand('watch',${JSON.stringify(api)},{session:'lifecycle'},()=>{});}catch(e){console.log(e.code);process.exitCode=2;}`],{env,stdout:'pipe',stderr:'pipe'});
    expect(await new Response(duplicate.stdout).text()).toContain('SESSION_BUSY');expect(await duplicate.exited).toBe(2);
    parent.kill('SIGKILL');await parent.exited;
    // Send a response after the parent is gone, before its next periodic check.
    if(mode==='late-response'){deliver=true;unblock?.();}
    await until(()=>existsSync(stopped));
    expect(acknowledgments).toBe(0);
    expect(readFileSync(output,'utf8')).toBe('');
    // The released lock must be immediately reusable by this chat's next watch.
    deliver=true;
    const replacementCode=`import{boardCommand,writeBoardOutput}from ${JSON.stringify(boardModule)};await boardCommand('wait',${JSON.stringify(api)},{session:'lifecycle'},d=>writeBoardOutput(d,true));`;
    const replacement=Bun.spawn([process.execPath,'-e',replacementCode],{env,stdout:'pipe',stderr:'pipe'});
    try{
      const [text,code]=await Promise.all([new Response(replacement.stdout).text(),replacement.exited]);
      expect(code).toBe(0);expect(text).toContain('must reach the replacement');expect(acknowledgments).toBe(1);
    }finally{replacement.kill();await replacement.exited;}
  }finally{
    parent.kill();await parent.exited;
    if(pid)try{process.kill(pid,'SIGKILL');}catch{}
    unblock?.();server.stop(true);rmSync(root,{recursive:true,force:true});
  }
},15_000);

test('a closed output ends a quiet listener without waiting for another message',async()=>{
  const root=mkdtempSync(join(tmpdir(),'board-output-lifecycle-'));let requests=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){requests++;return Response.json({schemaVersion:1,data:{batch:null,pollAfterMs:30_000}});}});
  const api=`http://127.0.0.1:${server.port}`,stopped=join(root,'stopped');
  const env={...process.env,OPENCRAWL_CONFIG_HOME:root,OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'disposable-board-lifecycle-token',OPENCRAWL_NO_UPDATE:'1'};
  const code=`import{boardCommand,writeBoardOutput}from ${JSON.stringify(boardModule)};import{writeFileSync}from'node:fs';
    setTimeout(()=>process.stdout.destroy(),500);
    try{await boardCommand('watch',${JSON.stringify(api)},{session:'output'},d=>writeBoardOutput(d,true));}finally{writeFileSync(${JSON.stringify(stopped)},'stopped');}`;
  const listener=Bun.spawn([process.execPath,'-e',code],{env,stdout:'pipe',stderr:'pipe'});
  try{await until(()=>requests>0);await until(()=>existsSync(stopped));expect(await listener.exited).toBe(0);}
  finally{listener.kill();await listener.exited;server.stop(true);rmSync(root,{recursive:true,force:true});}
},10_000);

test('parent exit waits for a rotating credential to be saved without delivering or acknowledging',async()=>{
  const root=mkdtempSync(join(tmpdir(),'board-refresh-lifecycle-'));
  let refreshes=0,boardRequests=0,finishRefresh:(()=>void)|undefined;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    if(new URL(req.url).pathname==='/token'){
      refreshes++;await new Promise<void>(resolve=>{finishRefresh=resolve;});
      return Response.json({access_token:'fresh',refresh_token:'rotated',expires_in:3600});
    }
    boardRequests++;return Response.json({schemaVersion:1,data:{left:true}});
  }});
  const api=`http://127.0.0.1:${server.port}`,sessionModule=resolve(import.meta.dir,'../src/session.ts');
  const env={...process.env,OPENCRAWL_CONFIG_HOME:root,OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'',OPENCRAWL_NO_UPDATE:'1'};
  const setup=Bun.spawn([process.execPath,'-e',`import{saveSession,sessionFile}from ${JSON.stringify(sessionModule)};
    await saveSession(${JSON.stringify(api)},{auth:{clientId:'fixture',deviceAuthorizationEndpoint:${JSON.stringify(api+'/device')},tokenEndpoint:${JSON.stringify(api+'/token')}},accessToken:'expired',refreshToken:'original',expiresAt:0});console.log(sessionFile(${JSON.stringify(api)}));`],{env,stdout:'pipe',stderr:'pipe'});
  const savedFile=(await new Response(setup.stdout).text()).trim();expect(await setup.exited).toBe(0);
  const stopped=join(root,'stopped'),pidFile=join(root,'pid'),output=join(root,'output'),watcher=join(root,'watcher.ts');
  writeFileSync(watcher,`import{boardCommand,writeBoardOutput}from ${JSON.stringify(boardModule)};import{writeFileSync}from'node:fs';
    try{await boardCommand('watch',${JSON.stringify(api)},{session:'rotation'},d=>writeBoardOutput(d,true));}finally{writeFileSync(${JSON.stringify(stopped)},'stopped');}`);
  const code=`import{spawn}from'node:child_process';import{openSync,writeFileSync}from'node:fs';
    const fd=openSync(${JSON.stringify(output)},'a');const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(watcher)}],{env:process.env,stdio:['ignore',fd,fd]});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const parent=Bun.spawn([process.execPath,'-e',code],{env,stdout:'ignore',stderr:'pipe'});let pid:number|undefined;
  try{
    await until(()=>existsSync(pidFile));pid=Number(readFileSync(pidFile,'utf8'));
    await until(()=>refreshes===1);parent.kill('SIGKILL');await parent.exited;
    await pause(700);expect(existsSync(stopped)).toBe(false);
    finishRefresh?.();await until(()=>existsSync(stopped));
    expect(JSON.parse(readFileSync(savedFile,'utf8')).refreshToken).toBe('rotated');
    expect(boardRequests).toBe(0);expect(readFileSync(output,'utf8')).toBe('');
  }finally{parent.kill();await parent.exited;if(pid)try{process.kill(pid,'SIGKILL');}catch{}finishRefresh?.();server.stop(true);rmSync(root,{recursive:true,force:true});}
},10_000);

test('closing the external pipe reader prevents acknowledgment of the next delivery',async()=>{
  const root=mkdtempSync(join(tmpdir(),'board-reader-lifecycle-'));let requests=0,acks=0,deliver=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
    if(new URL(req.url).pathname.endsWith('/ack'))acks++;else requests++;
    return Response.json({schemaVersion:1,data:{batch:deliver?{receipt:'a'.repeat(64),messages:[{id:1,text:'no reader remains'}]}:null,pollAfterMs:1000}});
  }});
  const api=`http://127.0.0.1:${server.port}`,stopped=join(root,'stopped');
  const env={...process.env,OPENCRAWL_CONFIG_HOME:root,OPENCRAWL_API_URL:api,OPENCRAWL_TOKEN:'disposable-board-lifecycle-token',OPENCRAWL_NO_UPDATE:'1'};
  const code=`import{boardCommand,writeBoardOutput}from ${JSON.stringify(boardModule)};import{writeFileSync}from'node:fs';
    try{await boardCommand('watch',${JSON.stringify(api)},{session:'reader'},d=>writeBoardOutput(d,true));}finally{writeFileSync(${JSON.stringify(stopped)},'stopped');}`;
  const listener=spawn(process.execPath,['-e',code],{env,stdio:['ignore','pipe','pipe']});
  const exited=new Promise<number|null>(resolve=>listener.once('exit',resolve));let errors='';listener.stderr!.on('data',chunk=>{errors+=String(chunk);});
  try{
    await until(()=>requests>0);listener.stdout!.destroy();
    // Some pipe implementations report reader loss only on a subsequent write.
    // No heartbeat is emitted merely to probe it; that write must never receipt.
    deliver=true;await until(()=>existsSync(stopped));expect({exit:await exited,acks,errors}).toEqual({exit:0,acks:0,errors:''});
  }finally{listener.kill('SIGKILL');await exited;server.stop(true);rmSync(root,{recursive:true,force:true});}
},10_000);
