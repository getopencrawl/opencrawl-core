import test from 'node:test';
import {snapshot,digest} from '../deploy/recovery.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(options={}){
 const root=mkdtempSync(join(tmpdir(),'opencrawl-backup-')),deploy=join(root,'deploy'),bin=join(root,'bin');mkdirSync(deploy);mkdirSync(bin);
 for(const file of ['installation.mjs','recovery.mjs','backup.mjs'])copyFileSync(new URL('../deploy/'+file,import.meta.url),join(deploy,file));
 const before='COMPOSE_PROJECT_NAME=existing\nOPENCRAWL_S3_SECRET_ACCESS_KEY=private-fixture-secret\n';writeFileSync(join(deploy,'.env'),before);
 const names=options.stateInit?['app','worker','app-state-ready','database-ready','s3','temporal-db']:['app','worker','temporal-db'];
 const dependencies={app:'app-state-ready:service_completed_successfully',worker:'app:service_healthy','app-state-ready':'database-ready:service_completed_successfully,s3:service_started','database-ready':'temporal-db:service_healthy'};
 const containers=names.map(name=>({Id:name,Image:'sha256:fixture',Config:{Labels:{'com.docker.compose.service':name,'com.docker.compose.project':'existing','com.docker.compose.oneoff':'False',...(options.stateInit&&dependencies[name]?{'com.docker.compose.depends_on':dependencies[name]}:{})},Cmd:['true'],Env:['SECRET=private-fixture-secret']},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},Mounts:[],State:{Running:!name.endsWith('-ready'),Health:{Status:'healthy'}}}));
 writeFileSync(join(bin,'git'),'#!/bin/sh\nprintf "%040d\\n" 1\n',{mode:0o700});
 writeFileSync(join(bin,'docker'),'#!/usr/bin/env node\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
 const options=JSON.parse(process.env.OPTIONS);
 if(a[0]==='ps')console.log(${JSON.stringify(names.join('\n'))});
 else if(a[0]==='inspect')console.log(${JSON.stringify(JSON.stringify(containers))});
 else if(a[0]==='image'&&a[1]==='tag'){}
 else if(a[0]==='image'&&a[1]==='inspect')console.log(a.at(-1).startsWith('opencrawl-recovery:')?'sha256:fixture':a.at(-1));
 else if(a[0]==='image'&&a[1]==='save')console.log(JSON.stringify({tags:a.slice(2)}));
 else if(a[0]==='stop'||a[0]==='start'){if(a[0]==='stop'&&options.failStop)process.exit(95);}
 else if(a[0]==='run'){if(options.failStoreArchive)process.exit(96);console.log('cold-store-archive');}
 else process.exit(19);
 `,{mode:0o700});
 const runScript=(name,args)=>spawnSync(process.execPath,[join(deploy,name),...args],{encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls'),OPTIONS:JSON.stringify(options)}});
 return {root,deploy,before,backupRun:args=>runScript('backup.mjs',args),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('ordinary backups use matched recovery and restart only the exact original containers',()=>{
 const f=fixture(),backup=join(f.root,'backup');try{
  const result=f.backupRun(['create',backup]);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8')).format,2);
  assert.ok(existsSync(join(backup,'images.tar')));assert.ok(existsSync(join(backup,'snapshot.json')));
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(calls.findIndex(a=>a[0]==='image'&&a[1]==='save')<calls.findIndex(a=>a[0]==='stop'));
  assert.deepEqual(calls.filter(a=>a[0]==='start').map(a=>a[1]).sort(),['app','temporal-db','worker']);
  assert.ok(!calls.some(a=>a[0]==='compose'),'backup must not recreate containers from a newer checkout');
  assert.ok(!result.stdout.includes('private-fixture-secret'));
 }finally{f.cleanup();}
});

test('failed cold archive restarts original containers but never marks an incomplete backup complete',()=>{
 const f=fixture({failStoreArchive:true}),backup=join(f.root,'backup');try{
  const result=f.backupRun(['create',backup]);assert.equal(result.status,1);
  assert.ok(existsSync(join(backup,'images.json')));assert.equal(existsSync(join(backup,'manifest.json')),false);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(a=>a[0]==='start').length,3);
 }finally{f.cleanup();}
});

test('backup restart follows completed init dependencies without rerunning migrations',()=>{
 const f=fixture({stateInit:true}),backup=join(f.root,'backup');try{
  const result=f.backupRun(['create',backup]);assert.equal(result.status,0,result.stderr);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const starts=calls.filter(a=>a[0]==='start').map(a=>a[1]);
  assert.deepEqual(starts,['temporal-db','s3','app','worker']);
 }finally{f.cleanup();}
});

test('a partial writer-stop failure restarts originals and cannot produce a cold backup',()=>{
 const f=fixture({failStop:true}),backup=join(f.root,'backup');try{
  const result=f.backupRun(['create',backup]);assert.equal(result.status,1);
  assert.equal(existsSync(join(backup,'manifest.json')),false);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(a=>a[0]==='start').length,3);
  assert.ok(!calls.some(a=>a[0]==='run'),'No archive is valid when draining failed');
 }finally{f.cleanup();}
});

test('leave-stopped backup retains a complete matched archive without restarting writers',()=>{
 const f=fixture(),backup=join(f.root,'backup');try{
  const result=f.backupRun(['create',backup,'--leave-stopped']);assert.equal(result.status,0,result.stderr);
  assert.ok(existsSync(join(backup,'manifest.json')));
  assert.ok(!readFileSync(join(f.root,'calls'),'utf8').includes('"start"'));
 }finally{f.cleanup();}
});
test('recovery Compose preserves literal environment values and omitted Docker health defaults',()=>{
 const runtime=['app','worker','temporal-db'].map(name=>({Image:'sha256:fixture',Config:{Labels:{'com.docker.compose.service':name},Cmd:['true'],Env:['SECRET=a$b'],Healthcheck:{Test:['CMD','true'],Interval:5000000000}},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},Mounts:[],State:{Running:true}}));
 const saved=snapshot({project:'fixture',kind:'deploy',configuration:[]},runtime);
 assert.equal(saved.compose.services.app.environment[0],'SECRET=a$$b');
 assert.equal(saved.compose.services.app.healthcheck.interval,'5000000000ns');
 assert.equal(saved.compose.services.app.healthcheck.timeout,undefined);
 assert.ok(!JSON.stringify(saved).includes('undefinedns'));
 assert.equal(saved.compose.services.worker.depends_on.app.condition,'service_healthy');
});


test('restore refuses a same-named empty volume owned by another project',async()=>{
 const root=mkdtempSync(join(tmpdir(),'opencrawl-restore-owner-')),deploy=join(root,'deploy'),bin=join(root,'bin'),backup=join(root,'backup');
 for(const path of [deploy,bin,backup])mkdirSync(path);
 try{
  for(const file of ['restore.mjs','installation.mjs','recovery.mjs','recovery-network.mjs'])copyFileSync(new URL('../deploy/'+file,import.meta.url),join(deploy,file));
  writeFileSync(join(backup,'snapshot.json'),JSON.stringify({format:2,project:'original',kind:'deploy',configurations:[],stores:[{name:'original_data',key:'store0'}],compose:{services:{app:{image:'sha256:fixture'}}}}));
  for(const name of ['stores.tgz','images.tar'])writeFileSync(join(backup,name),'synthetic');
  const files={};for(const name of ['snapshot.json','stores.tgz','images.tar'])files[name]=await digest(join(backup,name));
  writeFileSync(join(backup,'manifest.json'),JSON.stringify({format:2,files}));
  writeFileSync(join(bin,'docker'),'#!/usr/bin/env node\n'+`
   const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
   if(a[0]==='volume'&&a[1]==='ls')console.log('original_data');
   if(a[0]==='volume'&&a[1]==='inspect')console.log(JSON.stringify([{Labels:{'com.docker.compose.project':'another-installation'}}]));
  `,{mode:0o700});
  const result=spawnSync(process.execPath,[join(deploy,'restore.mjs'),'--backup',backup],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls')}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/volume ownership mismatch/);
  assert.ok(!readFileSync(join(root,'calls'),'utf8').includes('"run"'),'No helper may read or write the foreign volume');
 }finally{rmSync(root,{recursive:true,force:true});}
});
