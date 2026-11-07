import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {atomicJson,withSessionLock} from '../src/session.ts';
import {captureDir,captureTranscript,captureHook,flushCaptures,readCaptureConfig,type CaptureConfig} from '../src/capture/runtime.ts';
import {excludeCapture,purgeLocalCapture} from '../src/capture/controls.ts';
import {collectCommand} from '../src/capture/command.ts';
import {captureExcluded,projectPath} from '../src/capture/policy.ts';

test('install requires informed consent before changing files or contacting an endpoint',async()=>{
  const result:any=await collectCommand('install','https://unreachable.example',{json:true});
  expect(result.status).toBe('consent_required');expect(result.notice).toContain('not automatically redacted');
});

test('project and session exclusions block new bytes and queued uploads; purge is explicit and local',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-privacy-'));
  const previous=process.env.OPENCRAWL_CONFIG_HOME,previousToken=process.env.OPENCRAWL_SESSIONS_TOKEN;
  const owner={tenantId:'team',userId:'alice'},token='privacy-fixture-token';let writes=0;
  const server=createServer((req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
    if(req.url==='/api/sessions/identity'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{principal:owner}}));return;}
    writes++;res.writeHead(500).end();
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');process.env.OPENCRAWL_SESSIONS_TOKEN=token;
    const api='http://127.0.0.1:'+(server.address() as any).port;
    const config:CaptureConfig={schemaVersion:1,api,owner,installationId:'device',installedAt:new Date().toISOString(),roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
    mkdirSync(captureDir(),{recursive:true});atomicJson(join(captureDir(),'config.json'),config);
    const transcript=join(config.roots.codex,'sessions','session.jsonl');mkdirSync(join(config.roots.codex,'sessions'),{recursive:true});
    const project=join(dir,'sensitive');mkdirSync(project);
    const writeTranscript=(id:string,cwd:string)=>writeFileSync(transcript,[
      {type:'session_meta',payload:{id,cwd,source:'cli'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'private fixture'},{type:'input_image',image_url:'data:image/png;base64,cHJpdmF0ZQ=='}]}},
    ].map(r=>JSON.stringify(r)+'\n').join(''));
    writeTranscript('session',project);
    await captureTranscript(config,'codex',transcript);
    const queue=join(captureDir(),'queue');expect(readdirSync(queue)).toHaveLength(1);
    await excludeCapture(project);
    const pending=readFileSync(join(queue,readdirSync(queue)[0]),'utf8');
    expect(await flushCaptures()).toEqual({uploaded:0,excluded:1});expect(writes).toBe(0);
    expect(readFileSync(join(queue,readdirSync(queue)[0]),'utf8')).toBe(pending);
    const excluded=readCaptureConfig()!;
    expect(captureExcluded(excluded,{cwd:join(project,'child')})).toBe(true);
    expect(captureExcluded(excluded,{cwd:project+'-different'})).toBe(false);
    expect(captureExcluded(excluded,{})).toBe(true);
    const beforeBlobs=readdirSync(join(captureDir(),'blobs'));
    const fresh=join(config.roots.codex,'sessions','new.jsonl');
    writeFileSync(fresh,readFileSync(transcript,'utf8').replaceAll('session"','new-session"'));
    await captureTranscript(config,'codex',fresh);
    expect(readdirSync(queue)).toHaveLength(1);expect(readdirSync(join(captureDir(),'blobs'))).toEqual(beforeBlobs);
    await captureHook('codex',{session_id:'new-session',cwd:project,prompt:'private hook'});
    expect(readdirSync(join(captureDir(),'notices'))).toHaveLength(0);
    const mixed=join(config.roots.codex,'sessions','mixed.jsonl');
    writeFileSync(mixed,readFileSync(transcript,'utf8').replaceAll('session"','mixed-session"')+[
      {type:'turn_context',payload:{cwd:project+'-different'}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'allowed fixture'}]}},
    ].map(r=>JSON.stringify(r)+'\n').join(''));
    await captureTranscript(config,'codex',mixed);
    const allowed=readdirSync(queue).map(n=>JSON.parse(readFileSync(join(queue,n),'utf8'))).find(b=>b.sessionId==='mixed-session');
    expect(JSON.stringify(allowed)).toContain('allowed fixture');expect(JSON.stringify(allowed)).not.toContain('private fixture');
    await excludeCapture(undefined,'blocked');
    expect(captureExcluded(readCaptureConfig()!,{cwd:project+'-different',sessionId:'blocked:child'})).toBe(true);
    await expect(purgeLocalCapture(false)).rejects.toMatchObject({code:'PURGE_CONSENT_REQUIRED'});
    await expect(purgeLocalCapture(true)).rejects.toMatchObject({code:'CAPTURE_ACTIVE'});
    atomicJson(join(captureDir(),'config.json'),{...readCaptureConfig(),disabled:true});
    await withSessionLock('capture:worker',async()=>{
      await expect(purgeLocalCapture(true)).rejects.toMatchObject({code:'SESSION_BUSY'});
      expect(existsSync(queue)).toBe(true);
    },0);
    expect(await purgeLocalCapture(true)).toMatchObject({localCaptureDataDeleted:true,uploadedDataDeleted:false});
    expect(existsSync(queue)).toBe(false);expect(existsSync(transcript)).toBe(true);
    expect(readCaptureConfig()?.exclusions?.projects).toContain(projectPath(project));
  } finally {
    await new Promise<void>(r=>server.close(()=>r()));
    if(previous===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=previous;
    if(previousToken===undefined)delete process.env.OPENCRAWL_SESSIONS_TOKEN;else process.env.OPENCRAWL_SESSIONS_TOKEN=previousToken;
    rmSync(dir,{recursive:true,force:true});
  }
});
