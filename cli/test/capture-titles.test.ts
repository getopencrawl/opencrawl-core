import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {atomicJson} from '../src/session.ts';
import {captureDir, captureTranscript, refreshCapturedTitles, type CaptureConfig} from '../src/capture/runtime.ts';
import {parseRecord, hash} from '../src/capture/parse.ts';
import {codexTitle} from '../src/capture/titles.ts';
import {createServer} from 'node:http';

test('native title parsing preserves Claude auto/manual titles and Codex header titles only', () => {
  expect(parseRecord('claude-code', {type:'ai-title', aiTitle:'Automatic'}, 0)?.data.title).toBe('Automatic');
  expect(parseRecord('claude-code', {type:'custom-title', customTitle:'My name'}, 0)?.data.titleType).toBe('custom');
  expect(parseRecord('claude-code', {type:'custom-title', customTitle:'  '}, 0)).toBeNull();
  expect(parseRecord('codex', {type:'session_meta', payload:{id:'session', title:'Native name'}}, 0)?.data.title).toBe('Native name');
});

test('capture discovers Codex names and title-only renames without replaying messages; refresh respects enrollment and exclusions', async () => {
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-titles-')), saved=process.env.OPENCRAWL_CONFIG_HOME, savedToken=process.env.OPENCRAWL_SESSIONS_TOKEN;
  const owner={tenantId:'team',userId:'owner'}, received:any[]=[];
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/sessions/identity')return res.end(JSON.stringify({data:{principal:owner}}));
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const raw=Buffer.concat(chunks).toString(),batch=JSON.parse(raw);received.push(batch);
    res.end(JSON.stringify({data:{stored:true,batchId:hash(raw)}}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');process.env.OPENCRAWL_SESSIONS_TOKEN='fixture-token';
    const config:CaptureConfig={schemaVersion:1,api:'http://127.0.0.1:'+(server.address() as any).port,owner,installationId:'device',installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
    mkdirSync(captureDir(),{recursive:true});atomicJson(join(captureDir(),'config.json'),config);
    mkdirSync(join(config.roots.codex,'sessions'),{recursive:true});
    const path=join(config.roots.codex,'sessions','session.jsonl'),index=join(config.roots.codex,'session_index.jsonl');
    writeFileSync(path,[{type:'session_meta',payload:{id:'session',cwd:dir}}, {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'First request'}]}}].map(r=>JSON.stringify(r)+'\n').join(''));
    const entry=(id:string,title:string,time:string)=>JSON.stringify({id,thread_name:title,updated_at:time})+'\n';
    writeFileSync(index,entry('session','Actual chat name','2026-11-09T10:00:00Z')+entry('unseen','MUST NOT UPLOAD','2026-11-09T10:00:00Z')+'partial');
    await captureTranscript(config,'codex',path);
    let queued=readdirSync(join(captureDir(),'queue')).map(n=>JSON.parse(readFileSync(join(captureDir(),'queue',n),'utf8')));
    expect(queued.flatMap(b=>b.events).filter(e=>e.kind==='session_title').map(e=>e.data.title)).toEqual(['Actual chat name']);
    const count=queued.length;await captureTranscript(config,'codex',path);
    expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(count);
    // The rename lives only in the sidecar; the transcript has not changed.
    writeFileSync(index,entry('session','Renamed chat','2026-11-09T11:00:00Z')+entry('session','Stale name','2026-11-09T09:00:00Z')+entry('unseen','MUST NOT UPLOAD','2026-11-09T10:00:00Z'));
    expect(codexTitle(config.roots.codex,'session')?.title).toBe('Renamed chat');
    const result=await refreshCapturedTitles();expect(result.updated).toBe(1);
    expect(received.flatMap(b=>b.events).filter(e=>e.kind==='message')).toHaveLength(1);
    expect(received.flatMap(b=>b.events).filter(e=>e.kind==='session_title').map(e=>e.data.title).sort()).toEqual(['Actual chat name','Renamed chat']);
    expect(JSON.stringify(received)).not.toContain('MUST NOT UPLOAD');
    expect((await refreshCapturedTitles()).updated).toBe(0);
    atomicJson(join(captureDir(),'config.json'),{...config,exclusions:{projects:[],sessions:['session']}});
    appendFileSync(index,entry('session','EXCLUDED NAME','2026-11-09T12:00:00Z'));
    expect((await refreshCapturedTitles()).updated).toBe(0);expect(JSON.stringify(received)).not.toContain('EXCLUDED NAME');
    // Recover title records skipped by an older collector without rereading any
    // conversation into the upload, and retain manual names over auto titles.
    const claude=join(config.roots['claude-code'],'projects','fixture','claude.jsonl');mkdirSync(join(config.roots['claude-code'],'projects','fixture'),{recursive:true});
    const history=[{type:'user',sessionId:'claude',message:{role:'user',content:'ALREADY CAPTURED MESSAGE'}}, {type:'custom-title',sessionId:'claude',customTitle:'Manual Claude title'}, {type:'ai-title',sessionId:'claude',aiTitle:'Later automatic suggestion'}].map(r=>JSON.stringify(r)+'\n').join('');
    writeFileSync(claude,history);
    const {statSync}=await import('node:fs');
    atomicJson(join(captureDir(),'state',hash('claude-code'+claude)+'.json'),{offset:Buffer.byteLength(history),ino:statSync(claude).ino,meta:{harness:'claude-code',sessionId:'claude',sourcePath:claude,cwd:dir,origin:'cli'}});
    expect((await refreshCapturedTitles()).updated).toBe(1);
    const repaired=received.filter(b=>b.harness==='claude-code');
    expect(repaired).toHaveLength(1);expect(repaired[0].events.map((e:any)=>[e.kind,e.data.title])).toEqual([['session_title','Manual Claude title']]);
    expect(JSON.stringify(repaired)).not.toContain('ALREADY CAPTURED MESSAGE');
  } finally {
    if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;
    if(savedToken===undefined)delete process.env.OPENCRAWL_SESSIONS_TOKEN;else process.env.OPENCRAWL_SESSIONS_TOKEN=savedToken;
    await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});
  }
});
