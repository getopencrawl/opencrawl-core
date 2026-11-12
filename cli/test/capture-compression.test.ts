import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {gunzipSync} from 'node:zlib';
import {captureDir,flushCaptures,type CaptureConfig} from '../src/capture/runtime.ts';
import {createSessionIngest} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

test('negotiated gzip preserves privacy, lost receipts, legacy servers and rolling replicas',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'capture-compression-')),saved={...process.env},owner={tenantId:'team',userId:'author'};
 const ingest=createSessionIngest({store:createLocalSessionStore(join(dir,'objects'))});
 let phase='gzip',lostAck=true,badReceipt=false;
 const writes:{phase:string,encoding:string,wire:Buffer,plain:string}[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/sessions/identity'){
   const capabilities=phase==='legacy'?undefined:{batchEncodings:phase==='invalid-capability'?'gzip':['gzip']};
   res.end(JSON.stringify({data:{principal:owner,capabilities}}));return;
  }
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const wire=Buffer.concat(chunks),encoding=String(req.headers['content-encoding']??'identity');
  const plain=(encoding==='gzip'?gunzipSync(wire):wire).toString();writes.push({phase,encoding,wire,plain});
  if(encoding==='gzip'&&phase.startsWith('old-replica-')){res.writeHead(Number(phase.slice(-3)));res.end(JSON.stringify({error:{code:'CAPTURE_REJECTED'}}));return;}
  const receipt=await ingest.putBatch(owner,JSON.parse(plain));
  if(phase==='lost-ack'&&lostAck){lostAck=false;res.writeHead(503);res.end(JSON.stringify({error:{code:'LOST_ACK'}}));return;}
  res.end(JSON.stringify({data:badReceipt?{...receipt,batchId:'incorrect'}:receipt}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const api='http://127.0.0.1:'+(server.address() as any).port;
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'fixture-token'});
  const config:CaptureConfig={schemaVersion:1,api,owner,installationId:'device',installedAt:'2026-11-12T00:00:00Z',roots:{codex:join(dir,'codex'),'claude-code':join(dir,'claude')},command:[]};
  for(const name of ['queue','state','blobs','notices','sources'])mkdirSync(join(captureDir(),name),{recursive:true});
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
  const secret='ghp_'+'s'.repeat(36);
  const queue=(small=false)=>{
   const batch={schemaVersion:1,owner,installationId:'device',sessionId:phase,harness:'codex',origin:'cli',secretMaskVersion:999,events:[{id:'legacy-event',kind:'message',data:{text:secret+' '+(small?'small':'tool output 中文 '.repeat(5000))}}],attachments:[]};
   const original=JSON.stringify(batch);writeFileSync(join(captureDir(),'queue',phase+'.json'),original);return original;
  };
  for(const name of ['gzip','legacy','invalid-capability','old-replica-400','old-replica-415','lost-ack','small']){
   phase=name;queue(name==='small');const start=writes.length;
   expect((await flushCaptures()).uploaded).toBe(1);
   const sent=writes.slice(start);
   for(const item of sent){expect(item.plain).not.toContain(secret);expect(item.plain).toContain('[REDACTED]');}
   if(['legacy','invalid-capability','small'].includes(name))expect(sent.map(x=>x.encoding)).toEqual(['identity']);
   else if(name.startsWith('old-replica')){expect(sent.map(x=>x.encoding)).toEqual(['gzip','identity']);expect(sent[0].plain).toBe(sent[1].plain);}
   else{
    expect(sent.every(x=>x.encoding==='gzip')).toBe(true);expect(sent[0].wire.length).toBeLessThan(Buffer.byteLength(sent[0].plain)/10);
    if(name==='lost-ack'){expect(sent).toHaveLength(2);expect(sent[0].wire.equals(sent[1].wire)).toBe(true);}
   }
   expect(readdirSync(join(captureDir(),'queue'))).toHaveLength(0);
  }
  phase='invalid-receipt';badReceipt=true;const original=queue();
  await expect(flushCaptures()).rejects.toMatchObject({code:'CAPTURE_RECEIPT_INVALID'});
  expect(readFileSync(join(captureDir(),'queue',phase+'.json'),'utf8')).toBe(original);
  badReceipt=false;expect((await flushCaptures()).uploaded).toBe(1);
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});
 }
});
