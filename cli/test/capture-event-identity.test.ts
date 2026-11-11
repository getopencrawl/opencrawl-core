import {test,expect} from 'bun:test';
import {beforeEach, afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {finalizeEventIdentity,hash} from '../src/capture/parse.ts';
import {captureDir,captureTranscript,drainCaptureNotices,flushCaptures,type CaptureConfig} from '../src/capture/runtime.ts';
import {createSessionIngest,auditSessionEventIdentities} from '../../dist/src/sessions/ingest.mjs';
import {createLocalSessionStore} from '../../dist/src/sessions/local-store.mjs';

let priorTokenOrigin:string|undefined;
beforeEach(()=>{priorTokenOrigin=process.env.OPENCRAWL_API_URL;});
afterEach(()=>{if(priorTokenOrigin===undefined)delete process.env.OPENCRAWL_API_URL;else process.env.OPENCRAWL_API_URL=priorTokenOrigin;});

async function fixture(run:(directory:string,config:CaptureConfig)=>Promise<void>) {
 const directory=mkdtempSync(join(tmpdir(),'capture-wire-identity-')),saved=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=join(directory,'config');
 const config:CaptureConfig={schemaVersion:1,api:'http://127.0.0.1:1',installationId:'device',owner:{tenantId:'team',userId:'owner'},installedAt:'2026-11-01T00:00:00Z',roots:{'claude-code':join(directory,'claude'),codex:join(directory,'codex')},command:[]};
 for(const name of ['queue','state','blobs','notices','sources'])mkdirSync(join(captureDir(),name),{recursive:true});
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
 try{await run(directory,config);}finally{if(saved===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=saved;rmSync(directory,{recursive:true,force:true});}
}
function queued() {return readdirSync(join(captureDir(),'queue')).map(name=>({name,batch:JSON.parse(readFileSync(join(captureDir(),'queue',name),'utf8'))}));}

test('final event identity follows canonical wire JSON and includes normalized metadata',()=>{
 const source={id:'native-record-at-offset',kind:'message',timestamp:null,sequence:7,parentId:null,data:{right:2,left:1,optional:undefined,list:[1,2]},extra:NaN};
 const first=finalizeEventIdentity(source),reordered=finalizeEventIdentity({extra:null,data:{list:[1,2],left:1,right:2},parentId:null,sequence:7,timestamp:null,kind:'message',id:source.id});
 expect(first.id).toMatch(/^wire1:[a-f0-9]{64}$/);expect(reordered.id).toBe(first.id);
 expect(first.data.optional).toBeUndefined();expect(first.extra).toBeNull();expect(source.id).toBe('native-record-at-offset');
 for(const [field,value] of Object.entries({kind:'session_metadata',timestamp:'2026-11-06',sequence:8,parentId:'parent',agentId:'agent',data:{right:2,left:1,list:[2,1]},extra:0}))expect(finalizeEventIdentity({...source,[field]:value}).id).not.toBe(first.id);
 expect(finalizeEventIdentity({...source,id:'different-native-position'}).id).not.toBe(first.id);
 expect(finalizeEventIdentity(JSON.parse(JSON.stringify(source)))).toEqual(first);
});

test('replayed native attachment changes, disappearance and reappearance get safe immutable event identities',async()=>fixture(async(directory,config)=>{
 const transcript=join(config.roots['claude-code'],'projects','fixture','session.jsonl'),asset=join(directory,'image.png');mkdirSync(join(transcript,'..'),{recursive:true});
 const record={type:'user',sessionId:'session',uuid:'native',timestamp:'2026-11-06T00:00:00Z',message:{role:'user',content:[{type:'file',path:asset}]}};
 const raw=JSON.stringify(record)+'\n',ids:string[]=[],store=createLocalSessionStore(join(directory,'objects')),ingest=createSessionIngest({store});
 for(const content of ['first bytes','changed bytes',null,'first bytes']) {
  if(content===null)rmSync(asset);else writeFileSync(asset,content);
  // Replacing the inode is a supported transcript replay, without changing raw
  // record bytes/offset or manually resetting the collector's checkpoint.
  writeFileSync(transcript+'.replacement',raw);renameSync(transcript+'.replacement',transcript);
  await captureTranscript(config,'claude-code',transcript);
  const entries=queued();expect(entries).toHaveLength(1);const {name,batch}=entries[0];ids.push(batch.events[0].id);
  for(const attachment of batch.attachments)if(attachment.status==='captured')await ingest.putAttachment(config.owner,attachment.sha256,readFileSync(join(captureDir(),'blobs',attachment.sha256)),batch);
  expect((await ingest.putBatch(config.owner,batch)).stored).toBe(true);
  if(content===null)expect(batch.attachments[0].status).toBe('missing');else expect(batch.events[0].data.content[0].sha256).toBe(hash(content));
  const before=readFileSync(join(captureDir(),'queue',name));await captureTranscript(config,'claude-code',transcript);expect(readFileSync(join(captureDir(),'queue',name))).toEqual(before);
  rmSync(join(captureDir(),'queue',name));
 }
 expect(new Set(ids.slice(0,3)).size).toBe(3);expect(ids[3]).toBe(ids[0]);
 const audit=await auditSessionEventIdentities({store,prefix:'capture-v1',principal:config.owner,harness:'claude-code',installationId:config.installationId,sessionId:'session'});
 expect(audit?.conflicts).toBe(0);expect(audit?.events).toBe(3);
}));

test('hook enqueue replay retains final identity while normalized hook metadata changes create a new event',async()=>fixture(async(directory,config)=>{
 const notice={id:'stable-notice',at:'2026-11-06T00:00:00Z',harness:'claude-code',event:{session_id:'hook-session',prompt:'synthetic hook',image_url:'data:image/png;base64,'+Buffer.from('original image').toString('base64')}};
 const path=join(captureDir(),'notices',notice.id+'.json');
 writeFileSync(path,JSON.stringify(notice));await drainCaptureNotices(config);
 const original=queued()[0];expect(original.batch.events[0].id).toMatch(/^wire1:/);expect(original.batch.events[0].data.image_url).toBeUndefined();
 const bytes=readFileSync(join(captureDir(),'queue',original.name));
 // Model a crash after enqueue but before deleting the durable notice.
 writeFileSync(path,JSON.stringify(notice));await drainCaptureNotices(config);
 expect(queued()).toHaveLength(1);expect(readFileSync(join(captureDir(),'queue',original.name))).toEqual(bytes);
 writeFileSync(path,JSON.stringify({...notice,at:'2026-11-06T00:00:01Z'}));await drainCaptureNotices(config);
 expect(new Set(queued().map(({batch})=>batch.events[0].id)).size).toBe(2);
}));

test('upgrade leaves legacy queued bytes and IDs intact, including lost-acknowledgement retries',async()=>fixture(async(directory,config)=>{
 const token=process.env.OPENCRAWL_SESSIONS_TOKEN;process.env.OPENCRAWL_SESSIONS_TOKEN='fixture-token';
 const ingest=createSessionIngest({store:createLocalSessionStore(join(directory,'objects'))}),payloads:string[]=[];
 const server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/sessions/identity'){res.end(JSON.stringify({data:{principal:config.owner}}));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks).toString();payloads.push(body);
  const receipt=await ingest.putBatch(config.owner,JSON.parse(body));
  if(payloads.length===1){res.writeHead(502);res.end(JSON.stringify({error:{code:'LOST_ACKNOWLEDGEMENT'}}));return;}
  res.end(JSON.stringify({data:receipt}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));config.api='http://127.0.0.1:'+(server.address() as any).port;process.env.OPENCRAWL_API_URL=config.api;writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
 try {
  const batch={schemaVersion:1,owner:config.owner,installationId:config.installationId,sessionId:'legacy',harness:'codex',origin:'cli',events:[{id:'legacy-native-record',kind:'message',data:'unchanged queued content'}],attachments:[]};
  const serialized=JSON.stringify(batch);writeFileSync(join(captureDir(),'queue',hash(serialized)+'.json'),serialized+'\n');
  const checkpoint={offset:12345,ino:67890,parserVersion:2,meta:{sessionId:'legacy'}};writeFileSync(join(captureDir(),'state','legacy.json'),JSON.stringify(checkpoint));
  expect(await flushCaptures()).toEqual({uploaded:1});expect(payloads).toEqual([serialized,serialized]);expect(queued()).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(captureDir(),'state','legacy.json'),'utf8'))).toEqual(checkpoint);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(token===undefined)delete process.env.OPENCRAWL_SESSIONS_TOKEN;else process.env.OPENCRAWL_SESSIONS_TOKEN=token;}
}));
