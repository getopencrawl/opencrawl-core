import {test,expect} from 'bun:test';
import {beforeEach, afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {discoverMemories,refreshMemories,memoryDue,MEMORY_INTERVAL_MS} from '../src/capture/memory.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {withSessionLock} from '../src/session.ts';

let priorTokenOrigin:string|undefined;
beforeEach(()=>{priorTokenOrigin=process.env.OPENCRAWL_API_URL;});
afterEach(()=>{if(priorTokenOrigin===undefined)delete process.env.OPENCRAWL_API_URL;else process.env.OPENCRAWL_API_URL=priorTokenOrigin;});

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-memory-test-'));
  const prior=process.env.OPENCRAWL_CONFIG_HOME;process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
  const config:CaptureConfig={schemaVersion:1,api:'http://127.0.0.1:1',installationId:'fixture',owner:{tenantId:'tenant',userId:'author'},
    installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},harnesses:['codex','claude-code'],command:[]};
  for(const root of Object.values(config.roots))mkdirSync(root,{recursive:true});
  const put=(path:string,text:string)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text);};
  put(join(captureDir(),'config.json'),JSON.stringify(config));
  return {dir,config,put,close:()=>{if(prior===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=prior;rmSync(dir,{recursive:true,force:true});}};
}
test('full native discovery includes both Codex versions, Claude topics and subagents; excludes instructions, internals and symlinks',async()=>{
  const f=fixture();try {
    f.put(join(f.config.roots.codex,'memories/MEMORY.md'),'index');f.put(join(f.config.roots.codex,'memories_v2/rollout_summaries/summary.md'),'thread_id: source\nlesson');
    for(const path of ['memories/.git/private.md','memories/raw_memories.md','memories/extensions/ad_hoc/instructions.md','AGENTS.md'])f.put(join(f.config.roots.codex,path),'excluded');
    f.put(join(f.config.roots['claude-code'],'projects/repo/memory/MEMORY.md'),'index');f.put(join(f.config.roots['claude-code'],'projects/repo/memory/topic.md'),'topic');
    f.put(join(f.config.roots['claude-code'],'agent-memory/reviewer/MEMORY.md'),'subagent');
    if(process.platform!=='win32')symlinkSync(join(f.dir,'codex','AGENTS.md'),join(f.config.roots.codex,'memories/linked.md'));
    expect((await discoverMemories(f.config,'codex')).files.map(x=>x.text).sort()).toEqual(['index','thread_id: source\nlesson']);
    expect((await discoverMemories(f.config,'claude-code')).files).toHaveLength(3);
    const old=await discoverMemories(f.config,'codex');rmSync(join(f.config.roots.codex,'memories'),{recursive:true});
    const first=await discoverMemories(f.config,'codex',{roots:old.roots});expect(first.incomplete).toBe(true);
    const confirmed=await discoverMemories(f.config,'codex',{roots:old.roots,missing:first.missing});expect(confirmed.incomplete).toBe(false);expect(confirmed.files).toHaveLength(1);
  }finally{f.close();}
});
test('six-hour refresh uploads both harnesses once, skips unchanged files, detects edits/deletions and backs off failures',async()=>{
  const f=fixture(),oldToken=process.env.OPENCRAWL_SESSIONS_TOKEN;process.env.OPENCRAWL_SESSIONS_TOKEN='fixture';
  const uploads:any[]=[];let fail=false;const server=createServer(async(req,res)=>{
    if(fail){res.writeHead(403);res.end('{}');return;}
    let data:any={principal:f.config.owner};
    if(req.method==='POST'){let body='';for await(const part of req)body+=part;const snapshot=JSON.parse(body);uploads.push(snapshot);data={stored:true,snapshotId:createHash('sha256').update(body).digest('hex'),generation:snapshot.generation};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    f.config.api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=f.config.api;f.put(join(captureDir(),'config.json'),JSON.stringify(f.config));
    f.put(join(f.config.roots.codex,'memories/MEMORY.md'),'codex initial');f.put(join(f.config.roots['claude-code'],'projects/repo/memory/MEMORY.md'),'Claude initial');
    let now=Date.now();await refreshMemories({now:()=>now});expect(uploads).toHaveLength(2);
    await refreshMemories({now:()=>now+100});expect(uploads).toHaveLength(2);
    now+=MEMORY_INTERVAL_MS;await refreshMemories({now:()=>now});expect(uploads).toHaveLength(2);
    f.put(join(f.config.roots.codex,'memories/MEMORY.md'),'codex replacement');rmSync(join(f.config.roots['claude-code'],'projects/repo/memory/MEMORY.md'));
    now+=MEMORY_INTERVAL_MS;await refreshMemories({now:()=>now});expect(uploads).toHaveLength(4);expect(uploads[2].files[0].text).toBe('codex replacement');expect(uploads[3].files).toHaveLength(0);
    fail=true;now+=MEMORY_INTERVAL_MS;await refreshMemories({now:()=>now});
    const states=readdirSync(join(captureDir(),'memories')).map(p=>JSON.parse(readFileSync(join(captureDir(),'memories',p),'utf8')));
    expect(states.every(s=>s.successAt<now&&s.retryAt>now)).toBe(true);
    expect(memoryDue(states[0],now)).toBe(false);expect(memoryDue(states[0],now+16*60*1000)).toBe(true);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(oldToken===undefined)delete process.env.OPENCRAWL_SESSIONS_TOKEN;else process.env.OPENCRAWL_SESSIONS_TOKEN=oldToken;f.close();}
});
test('a cancelled invocation never blocks on authentication or marks an incomplete refresh successful',async()=>{
  const f=fixture(),oldToken=process.env.OPENCRAWL_SESSIONS_TOKEN;process.env.OPENCRAWL_SESSIONS_TOKEN='fixture';
  const server=createServer(()=>{});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    f.config.api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=f.config.api;f.put(join(captureDir(),'config.json'),JSON.stringify(f.config));
    const controller=new AbortController(),start=Date.now();setTimeout(()=>controller.abort(),30);
    await refreshMemories({signal:controller.signal});expect(Date.now()-start).toBeLessThan(1000);
    expect(memoryDue({})).toBe(true);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(oldToken===undefined)delete process.env.OPENCRAWL_SESSIONS_TOKEN;else process.env.OPENCRAWL_SESSIONS_TOKEN=oldToken;f.close();}
});
test('memory waits asynchronously for a session upload and cancellation leaves the refresh due',async()=>{
  const f=fixture(),oldToken=process.env.OPENCRAWL_SESSIONS_TOKEN;process.env.OPENCRAWL_SESSIONS_TOKEN='fixture';
  const uploads:any[]=[];const server=createServer(async(req,res)=>{
    let data:any={principal:f.config.owner};
    if(req.method==='POST'){let body='';for await(const part of req)body+=part;const s=JSON.parse(body);uploads.push(s);data={stored:true,snapshotId:createHash('sha256').update(body).digest('hex'),generation:s.generation};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  let release:()=>void=()=>{};let owner:Promise<unknown>|undefined;
  try{
    f.config.api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=f.config.api;f.put(join(captureDir(),'config.json'),JSON.stringify(f.config));
    f.put(join(f.config.roots.codex,'memories/MEMORY.md'),'codex');f.put(join(f.config.roots['claude-code'],'projects/repo/memory/MEMORY.md'),'Claude');
    owner=withSessionLock('capture:flush',()=>new Promise<void>(r=>{release=r;}));
    const pending=refreshMemories();await new Promise(r=>setTimeout(r,120));expect(uploads).toHaveLength(0);
    release();await owner;await pending;expect(uploads).toHaveLength(2);
    rmSync(join(captureDir(),'memories'),{recursive:true});
    owner=withSessionLock('capture:flush',()=>new Promise<void>(r=>{release=r;}));
    const controller=new AbortController(),start=Date.now();setTimeout(()=>controller.abort(),120);
    await refreshMemories({signal:controller.signal});expect(Date.now()-start).toBeLessThan(1000);expect(uploads).toHaveLength(2);
    const states=readdirSync(join(captureDir(),'memories')).map(p=>JSON.parse(readFileSync(join(captureDir(),'memories',p),'utf8')));
    expect(states.length).toBeGreaterThan(0);expect(states.every(s=>memoryDue(s)&&!s.retryAt&&!s.successAt)).toBe(true);
  }finally{release();await owner;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(oldToken===undefined)delete process.env.OPENCRAWL_SESSIONS_TOKEN;else process.env.OPENCRAWL_SESSIONS_TOKEN=oldToken;f.close();}
});
test('project or session exclusions pause consolidated memory before network or file reads',async()=>{
  const f=fixture();try {
    for(const exclusions of [{projects:[f.dir],sessions:[]},{projects:[],sessions:['private-session']}]) {
      f.put(join(captureDir(),'config.json'),JSON.stringify({...f.config,exclusions}));
      const old=globalThis.fetch;let requested=false;
      globalThis.fetch=(async()=>{requested=true;throw new Error('unexpected network');}) as unknown as typeof fetch;
      try{await refreshMemories();expect(requested).toBe(false);}finally{globalThis.fetch=old;}
    }
  }finally{f.close();}
});
test('ordinary CLI invocation refreshes opportunistically; help returns immediately during an unavailable receiver',async()=>{
  const f=fixture(),received:any[]=[];let blocked=false;
  let uploadsComplete=()=>{};
  const uploadsReady=new Promise<void>(resolve=>{uploadsComplete=resolve;});
  const server=createServer(async(req,res)=>{
    if(blocked)return;
    let data:any={principal:f.config.owner};
    if(req.url==='/api/cli/me'){
      // Foreground completion cancels opportunistic work. Wait for receipts,
      // not an assumed filesystem/network speed on the runner.
      let deadline:ReturnType<typeof setTimeout>|undefined;
      try{await Promise.race([uploadsReady,new Promise<void>(resolve=>{deadline=setTimeout(resolve,3000);})]);}
      finally{clearTimeout(deadline);}
      data={user:{id:'author',email:'fixture@example.test'}};
    }
    if(req.method==='POST'){let body='';for await(const part of req)body+=part;const s=JSON.parse(body);received.push(s);if(received.length===2)uploadsComplete();data={stored:true,snapshotId:createHash('sha256').update(body).digest('hex'),generation:s.generation};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    f.config.api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=f.config.api;f.put(join(captureDir(),'config.json'),JSON.stringify(f.config));
    f.put(join(f.config.roots.codex,'memories/MEMORY.md'),'native codex');f.put(join(f.config.roots['claude-code'],'projects/repo/memory/MEMORY.md'),'native Claude');
    const {sessionFile}=await import('../src/session.ts');
    f.put(sessionFile(f.config.api),JSON.stringify({auth:{clientId:'fixture',tokenEndpoint:f.config.api+'/token'},accessToken:'fixture',refreshToken:'fixture',expiresAt:Date.now()+3600000}));
    const child=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'whoami','--api',f.config.api,'--json'],{env:{...process.env,OPENCRAWL_SESSIONS_TOKEN:'fixture'},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(0);expect(received).toHaveLength(2);
    blocked=true;rmSync(join(captureDir(),'memories'),{recursive:true});
    const start=Date.now(),help=Bun.spawn([process.execPath,join(import.meta.dir,'../src/cli.ts'),'--help'],{env:{...process.env,OPENCRAWL_SESSIONS_TOKEN:'fixture'},stdout:'pipe',stderr:'pipe'});
    expect(await help.exited).toBe(0);expect(Date.now()-start).toBeLessThan(1000);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));f.close();}
});
