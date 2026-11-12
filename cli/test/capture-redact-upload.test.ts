import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {captureDir,captureTranscript,drainCaptureNotices,flushCaptures,type CaptureConfig} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';

const secret='ghp_'+'S'.repeat(36),uuid='550e8400-e29b-41d4-a716-446655440000';
test('all capture sources and legacy retries mask locally before batch and decoded attachment egress',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-mask-')),saved={...process.env};
  const writes:{url:string,body:Buffer}[]=[];let lostAck=true;
  const owner={tenantId:'team',userId:'owner'};
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:owner}}));return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);writes.push({url:req.url!,body});
    if(req.method==='PUT'){res.end(JSON.stringify({data:{sha256:hash(body),size:body.length}}));return;}
    if(req.url==='/api/sessions/batches' && lostAck){lostAck=false;res.writeHead(502);res.end(JSON.stringify({error:{code:'LOST_ACK'}}));return;}
    res.end(JSON.stringify({data:{stored:true,batchId:hash(body)}}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    process.env.OPENCRAWL_CONFIG_HOME=join(dir,'config');
    process.env.OPENCRAWL_SESSIONS_TOKEN='test-receiver-token';
    const api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=api;
    const config:CaptureConfig={schemaVersion:1,api,owner,installationId:uuid,installedAt:'2026-11-01T00:00:00Z',roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
    for(const name of ['queue','blobs','notices','state','sources'])mkdirSync(join(captureDir(),name),{recursive:true});
    writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
    const codex=join(config.roots.codex,'sessions','fixture.jsonl');mkdirSync(join(codex,'..'),{recursive:true});
    const sensitiveProject=join(dir,secret);mkdirSync(sensitiveProject);
    const records=[
      {type:'session_meta',payload:{id:uuid,source:'cli',cwd:sensitiveProject,title:'title '+secret}},
      {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'prompt '+secret+' '+uuid},{type:'input_image',image_url:'data:text/plain;base64,'+Buffer.from('attachment '+secret+' '+uuid).toString('base64')}]}},
      {type:'response_item',payload:{type:'function_call',call_id:uuid,arguments:JSON.stringify({api_key:'opaque-sensitive-value',traceId:uuid})}},
      {type:'response_item',payload:{type:'function_call_output',call_id:uuid,output:'tool result '+secret}},
      {type:'response_item',payload:{type:'message',role:'assistant',content:'reply '+secret}},
    ];
    const transcript=records.map(r=>JSON.stringify(r)+'\n').join('');writeFileSync(codex,transcript);
    await captureTranscript(config,'codex',codex);
    const claude=join(config.roots['claude-code'],'projects','fixture','session.jsonl');mkdirSync(join(claude,'..'),{recursive:true});
    const asset=join(dir,'attachment.txt');writeFileSync(asset,secret);
    writeFileSync(claude,JSON.stringify({type:'user',sessionId:'claude',uuid,cwd:dir,message:{role:'user',content:[{type:'text',text:secret},{type:'file',path:asset}]}})+'\n');
    await captureTranscript(config,'claude-code',claude);
    writeFileSync(join(captureDir(),'notices','hook.json'),JSON.stringify({id:'hook',at:'2026-11-01T00:00:00Z',harness:'claude-code',event:{session_id:'hook',cwd:dir,prompt:secret}}));
    writeFileSync(join(captureDir(),'notices','grok.json'),JSON.stringify({id:'grok',sequence:1,at:'2026-11-01T00:00:00Z',harness:'grok-bot',event:{conversation_id:uuid,hook_event_name:'postToolUse',cwd:dir,tool_name:'Shell',tool_input:{api_key:secret},tool_output:secret}}));
    let deep:any={token:secret};for(let n=0;n<300;n++)deep={next:deep};
    writeFileSync(join(captureDir(),'notices','grok-deep.json'),JSON.stringify({id:'grok-deep',sequence:2,at:'2026-11-01T00:00:00Z',harness:'grok-bot',event:{conversation_id:uuid,hook_event_name:'postToolUse',cwd:dir,tool_name:'Shell',tool_input:{},tool_output:JSON.stringify(deep)}}));
    await drainCaptureNotices(config);
    for(const file of readdirSync(join(captureDir(),'queue'))) {
      const {cwd,sessionId,...content}=JSON.parse(readFileSync(join(captureDir(),'queue',file),'utf8'));
      expect(JSON.stringify(content)).not.toContain(secret);
    }
    for(const file of readdirSync(join(captureDir(),'blobs')))expect(readFileSync(join(captureDir(),'blobs',file),'utf8')).not.toContain(secret);
    expect(readFileSync(codex,'utf8')).toBe(transcript);expect(readFileSync(asset,'utf8')).toBe(secret);
    // Older CLIs queued raw JSON/blobs. Recheck them regardless of any flag.
    const raw=Buffer.from('legacy '+secret+' '+uuid),sha256=hash(raw);
    const binary=Buffer.concat([Buffer.from([0,255]),Buffer.from(secret)]),binaryHash=hash(binary);
    writeFileSync(join(captureDir(),'blobs',sha256),raw);writeFileSync(join(captureDir(),'blobs',binaryHash),binary);
    const attachments=[{sha256,size:raw.length,status:'captured'},{sha256:binaryHash,size:binary.length,status:'captured'}];
    const batch={schemaVersion:1,owner,installationId:uuid,sessionId:'legacy',harness:'codex',origin:'cli',secretMaskVersion:999,events:[{id:'old-id',kind:'message',data:{text:secret,traceId:uuid,attachments}}],attachments};
    writeFileSync(join(captureDir(),'queue','legacy.json'),JSON.stringify(batch));
    expect((await flushCaptures()).uploaded).toBe(5);
    for(const write of writes) {
      expect(write.body.toString()).not.toContain(secret);expect(write.body.toString()).not.toContain('opaque-sensitive-value');
      if(write.url.startsWith('/api/sessions/attachments/')){
        const url=new URL(write.url,api);expect(url.pathname).toBe('/api/sessions/attachments/'+hash(write.body));
        expect(url.searchParams.get('installationId')).toBe(uuid);
        expect(writes.filter(w=>w.url==='/api/sessions/batches').some(w=>{
          const batch=JSON.parse(w.body.toString());return batch.harness===url.searchParams.get('harness')&&batch.sessionId===url.searchParams.get('sessionId');
        })).toBe(true);
      }
    }
    const batches=writes.filter(w=>w.url==='/api/sessions/batches').map(w=>w.body.toString());
    expect(batches[0]).toBe(batches[1]);
    const legacy=batches.map(b=>JSON.parse(b)).find(b=>b.sessionId==='legacy');
    expect(legacy.events[0].id).not.toBe('old-id');expect(legacy.events[0].data.traceId).toBe(uuid);
    expect(legacy.attachments[0].sha256).toBe(hash('legacy [REDACTED] '+uuid));
    expect(legacy.events[0].data.attachments).toEqual(legacy.attachments);
    expect(legacy.attachments[1]).toMatchObject({status:'missing',redactionReason:'secret_in_binary'});
    expect(writes.some(w=>new URL(w.url,api).pathname.endsWith(binaryHash))).toBe(false);
    expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
    // Resolve and scan every blob before sending any body, failing closed even
    // when a preceding attachment was valid. Keep queue/cursor state for retry.
    writeFileSync(join(captureDir(),'blobs',binaryHash),'corrupt local blob');
    writeFileSync(join(captureDir(),'queue','invalid.json'),JSON.stringify(batch));
    const before=writes.length;
    await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_ATTACHMENT_INVALID'});
    expect(writes).toHaveLength(before);expect(readdirSync(join(captureDir(),'queue'))).toEqual(['invalid.json']);
  } finally {
    await new Promise<void>(r=>server.close(()=>r()));
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
    rmSync(dir,{recursive:true,force:true});
  }
});
