import {test,expect} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {captureDir,flushCaptures,type CaptureConfig} from '../src/capture/runtime.ts';
import {hash} from '../src/capture/parse.ts';
import {readPermission} from '../src/capture/recording.ts';

test('a paused flush sends zero payload bytes, and an offline mixed queue resumes without private events or blobs',async()=>{
  const saved={...process.env},root=mkdtempSync(join(tmpdir(),'recording-wire-'));
  const principal={tenantId:'team',userId:'owner'},from=Date.parse('2026-10-05T12:00:00Z'),to=from+3600000;
  let paused=true,revision=randomUUID();
  const requests:{path:string;bytes:number}[]=[],wire:string[]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    const body=Buffer.concat(chunks);requests.push({path:req.url!,bytes:body.length});
    res.setHeader('content-type','application/json');
    if(req.url==='/api/sessions/identity'){
      const known=req.headers['x-opencrawl-recording'];
      res.end(JSON.stringify({data:{principal,recording:{paused,revision,until:paused?to:null,...known!==revision&&{windows:[[from,to]]}}}}));return;
    }
    wire.push(body.toString());expect(req.headers['x-opencrawl-recording']).toBe(revision);
    res.end(JSON.stringify({data:{stored:true,batchId:hash(body)}}));
  });
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const api='http://127.0.0.1:'+(server.address() as AddressInfo).port;
    Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:root,OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'test'});
    mkdirSync(join(captureDir(),'queue'),{recursive:true});
    const config:CaptureConfig={schemaVersion:1,api,owner:principal,installationId:'local',command:[],installedAt:new Date().toISOString(),roots:{codex:root,'claude-code':root}};
    writeFileSync(join(captureDir(),'config.json'),JSON.stringify(config));
    const event=(id:string,time:number,data:object)=>({id,kind:'message',timestamp:new Date(time).toISOString(),data});
    const privateBlob={type:'opencrawl_attachment',status:'captured',sha256:hash('private bytes')};
    const batch={schemaVersion:1,owner:principal,installationId:'local',sessionId:'one',harness:'codex',origin:'cli',events:[
      event('a',from-1,{text:'keep before'}),event('b',from,{text:'private words',attachment:privateBlob}),event('c',to,{text:'keep after'}),
    ],attachments:[privateBlob]};
    writeFileSync(join(captureDir(),'queue','mixed.json'),JSON.stringify(batch));
    expect((await flushCaptures({wait:false})).uploaded).toBe(0);
    expect(requests).toEqual([{path:'/api/sessions/identity',bytes:0}]);
    paused=false;revision=randomUUID();
    expect((await flushCaptures()).uploaded).toBe(1);
    expect(requests.map(r=>r.path)).toEqual(['/api/sessions/identity','/api/sessions/identity','/api/sessions/batches']);
    expect(wire[0]).toContain('keep before');expect(wire[0]).toContain('keep after');
    expect(wire[0]).not.toContain('private words');expect(wire[0]).not.toContain(privateBlob.sha256);
  }finally{
    server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));
    for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];
    Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true});
  }
});

test('a missing or invalid sentinel cannot downgrade a known recording policy',()=>{
  const previous=readPermission({revision:'0',paused:false,until:null,windows:[]})!;
  expect(()=>readPermission(undefined,previous)).toThrow();
  expect(()=>readPermission({revision:randomUUID(),paused:false,until:null},previous)).toThrow();
  expect(readPermission({revision:'0',paused:false,until:null},previous)).toEqual(previous);
});
