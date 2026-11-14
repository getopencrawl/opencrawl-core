import test from 'node:test';
import {snapshot,digest} from '../deploy/recovery.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(options={}){
 const root=mkdtempSync(join(tmpdir(),'opencrawl-full-upgrade-')),deploy=join(root,'deploy'),bin=join(root,'bin');mkdirSync(deploy);mkdirSync(bin);
 for(const file of ['upgrade.mjs','installation.mjs','recovery.mjs'])copyFileSync(new URL('../deploy/'+file,import.meta.url),join(deploy,file));
 const before='COMPOSE_PROJECT_NAME=existing\nOPENCRAWL_S3_SECRET_ACCESS_KEY=private-fixture-secret\n';writeFileSync(join(deploy,'.env'),before);
 const containers=['app','worker','temporal-db'].map(name=>({Id:name,Image:'sha256:fixture',Config:{Labels:{'com.docker.compose.service':name,'com.docker.compose.oneoff':'False'},Cmd:['true'],Env:['SECRET=private-fixture-secret']},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},Mounts:[],State:{Running:true}}));
 writeFileSync(join(bin,'git'),'#!/bin/sh\nprintf "%040d\\n" 1\n',{mode:0o700});
 writeFileSync(join(bin,'docker'),'#!/usr/bin/env node\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2),stateFile=process.env.CALLS+'.state';fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
 const options=JSON.parse(process.env.OPTIONS),state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{oldAvailable:true,tags:{},newRunning:false};
 const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state));
 if(a[0]==='ps')console.log('app\\nworker\\ntemporal-db');
 else if(a[0]==='inspect'){const rows=${JSON.stringify(containers)};if(state.newRunning)for(const row of rows)if(['app','worker'].includes(row.Id))row.Image='sha256:new';console.log(JSON.stringify(rows));}
 else if(a[0]==='image'&&a[1]==='tag'){if(!state.oldAvailable)process.exit(125);state.tags[a[3]]=a[2];save();}
 else if(a[0]==='image'&&a[1]==='inspect'){const ref=a.at(-1);if(!state.oldAvailable)process.exit(125);console.log(state.tags[ref]||ref);}
 else if(a[0]==='image'&&a[1]==='save'){if(options.failImageSave)process.exit(18);if(!state.oldAvailable)process.exit(125);console.log(JSON.stringify({tags:Object.fromEntries(a.slice(2).map(tag=>[tag,state.tags[tag]]))}));}
 else if(a[0]==='image'&&a[1]==='load'){if(options.failImageLoad)process.exit(125);Object.assign(state.tags,JSON.parse(fs.readFileSync(0,'utf8')).tags);state.oldAvailable=true;save();}
 else if(a.includes('build')){if(options.failBuild!==false)process.exit(17);if(options.loseImagesAfterBuild)state.oldAvailable=false;save();}
 else if(a[0]==='stop'){}
 else if(a[0]==='run'){if(!state.oldAvailable)process.exit(125);console.log('cold-store-archive');}
 else if(a[0]==='compose'){if(a.includes('dist/src/sessions/identity-migration.mjs')&&options.failMigration)process.exit(97);if(a.includes('up')&&a.includes('app')){state.newRunning=true;save();}}
 else process.exit(19);
 `,{mode:0o700});
 const run=args=>spawnSync(process.execPath,[join(deploy,'upgrade.mjs'),...args],{encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls'),OPTIONS:JSON.stringify(options)}});
 return {root,deploy,before,run,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('upgrade check is read-only and does not disclose persisted credentials',()=>{
 const f=fixture();try{
  const r=f.run(['--check']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).needed,true);
  assert.equal(existsSync(join(f.deploy,'.upgrade')),false);assert.equal(readFileSync(join(f.deploy,'.env'),'utf8'),f.before);
  assert.ok(!r.stdout.includes('private-fixture-secret'));assert.ok(!readFileSync(join(f.root,'calls'),'utf8').includes('stop'));
 }finally{f.cleanup();}
});
test('a failed target build leaves old writers and credentials unchanged, and can retry',()=>{
 const f=fixture();try{
  for(let attempt=0;attempt<2;attempt++){
   const r=f.run([]);assert.equal(r.status,1);assert.match(r.stderr,/"phase":"images-preserved"/);
   assert.equal(readFileSync(join(f.deploy,'.env'),'utf8'),f.before);
   assert.ok(!readFileSync(join(f.root,'calls'),'utf8').includes('stop'));
  }
  const journal=JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8'));
  assert.equal(journal.phase,'images-preserved');assert.equal(existsSync(join(journal.backup,'manifest.json')),false);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(calls.filter(args=>args[0]==='image'&&args[1]==='save').length,1,'retry reuses the original exported images');
  assert.equal(calls.filter(args=>args.includes('build')).length,2);
 }finally{f.cleanup();}
});

test('image preservation fails before a build or stopping old writers',()=>{
 const f=fixture({failImageSave:true});try{
  const result=f.run([]);assert.equal(result.status,1);assert.match(result.stderr,/"phase":"prepared"/);
  const calls=readFileSync(join(f.root,'calls'),'utf8');assert.ok(!calls.includes('"build"'));assert.ok(!calls.includes('"stop"'));
  const journal=JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8'));assert.equal(existsSync(join(journal.backup,'manifest.json')),false);
 }finally{f.cleanup();}
});

test('retagged image loss reloads the preserved old images before downtime and completes a matched backup',()=>{
 const f=fixture({failBuild:false,loseImagesAfterBuild:true});try{
  const result=f.run([]);assert.equal(result.status,0,result.stderr);
  const journal=JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8'));assert.equal(journal.phase,'complete');
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const saved=calls.findIndex(a=>a[0]==='image'&&a[1]==='save'),built=calls.findIndex(a=>a.includes('build')),loaded=calls.findIndex(a=>a[0]==='image'&&a[1]==='load'),stopped=calls.findIndex(a=>a[0]==='stop'),stores=calls.findIndex(a=>a[0]==='run');
  assert.ok(saved<built&&built<loaded&&loaded<stopped&&stopped<stores,JSON.stringify(calls));
  const images=JSON.parse(readFileSync(join(journal.backup,'images.tar'),'utf8'));
  assert.ok(Object.keys(images.tags).every(tag=>tag.startsWith('opencrawl-recovery:')),'loading recovery must not overwrite the target application tag');
  assert.ok(existsSync(join(journal.backup,'manifest.json')));
  assert.equal(readFileSync(join(journal.backup,'stores.tgz'),'utf8'),'cold-store-archive\n');
 }finally{f.cleanup();}
});

test('a corrupt image archive stops a retry before build or downtime',()=>{
 const f=fixture();try{
  assert.equal(f.run([]).status,1);
  const journal=JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8'));
  writeFileSync(join(journal.backup,'images.tar'),'corrupt');writeFileSync(join(f.root,'calls'),'');
  const result=f.run([]);assert.equal(result.status,1);assert.match(result.stderr,/checksum or identity mismatch/);
  const calls=readFileSync(join(f.root,'calls'),'utf8');assert.ok(!calls.includes('"build"'));assert.ok(!calls.includes('"stop"'));
 }finally{f.cleanup();}
});

test('failed reload after retagging leaves the old application running and retains the image archive',()=>{
 const f=fixture({failBuild:false,loseImagesAfterBuild:true,failImageLoad:true});try{
  const result=f.run([]);assert.equal(result.status,1);assert.match(result.stderr,/"phase":"built"/);
  const calls=readFileSync(join(f.root,'calls'),'utf8');assert.ok(!calls.includes('"stop"'));
  const journal=JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8'));
  assert.ok(existsSync(join(journal.backup,'images.tar')));assert.ok(existsSync(join(journal.backup,'images.json')));
  assert.equal(existsSync(join(journal.backup,'manifest.json')),false);
 }finally{f.cleanup();}
});

test('an old built journal preserves its original snapshot and images before it can stop writers',()=>{
 const f=fixture();try{
  assert.equal(f.run([]).status,1);
  const file=join(f.deploy,'.upgrade/upgrade.json'),journal=JSON.parse(readFileSync(file,'utf8'));
  journal.phase='built';writeFileSync(file,JSON.stringify(journal));
  rmSync(join(journal.backup,'images.json'));rmSync(join(journal.backup,'images.tar'));writeFileSync(join(f.root,'calls'),'');
  const result=f.run([]);assert.equal(result.status,0,result.stderr);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(!calls.some(a=>a.includes('build')));
  assert.ok(calls.findIndex(a=>a[0]==='image'&&a[1]==='save')<calls.findIndex(a=>a[0]==='stop'));
  assert.deepEqual(JSON.parse(readFileSync(join(journal.backup,'snapshot.json'),'utf8')),journal.snapshot);
 }finally{f.cleanup();}
});

test('an old incomplete journal with missing original images fails without replacing its recovery state',()=>{
 const f=fixture();try{
  assert.equal(f.run([]).status,1);
  const file=join(f.deploy,'.upgrade/upgrade.json'),journal=JSON.parse(readFileSync(file,'utf8'));
  journal.phase='built';writeFileSync(file,JSON.stringify(journal));
  rmSync(join(journal.backup,'images.json'));rmSync(join(journal.backup,'images.tar'));
  const snapshotBefore=readFileSync(join(journal.backup,'snapshot.json'));
  const state=join(f.root,'calls.state');writeFileSync(state,JSON.stringify({...JSON.parse(readFileSync(state,'utf8')),oldAvailable:false}));writeFileSync(join(f.root,'calls'),'');
  const result=f.run([]);assert.equal(result.status,1);assert.match(result.stderr,/"phase":"built"/);
  const calls=readFileSync(join(f.root,'calls'),'utf8');assert.ok(!calls.includes('"build"'));assert.ok(!calls.includes('"stop"'));
  assert.ok(readFileSync(join(journal.backup,'snapshot.json')).equals(snapshotBefore));assert.equal(existsSync(join(journal.backup,'manifest.json')),false);
 }finally{f.cleanup();}
});

test('a different target cannot resume or stop an old failed installation with missing images',()=>{
 const f=fixture();try{
  assert.equal(f.run([]).status,1);
  const file=join(f.deploy,'.upgrade/upgrade.json'),journal=JSON.parse(readFileSync(file,'utf8'));
  journal.phase='stopped';journal.target='2'.repeat(40);writeFileSync(file,JSON.stringify(journal));
  rmSync(join(journal.backup,'images.json'));rmSync(join(journal.backup,'images.tar'));
  const state=join(f.root,'calls.state');writeFileSync(state,JSON.stringify({...JSON.parse(readFileSync(state,'utf8')),oldAvailable:false}));
  const journalBefore=readFileSync(file),snapshotBefore=readFileSync(join(journal.backup,'snapshot.json')),stateBefore=readFileSync(state);
  writeFileSync(join(f.root,'calls'),'');
  const result=f.run([]);assert.equal(result.status,1);assert.match(result.stderr,/Return to its recorded target revision/);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(calls.every(args=>['ps','inspect'].includes(args[0])),'A rejected target must only inspect containers: '+JSON.stringify(calls));
  assert.ok(readFileSync(file).equals(journalBefore));assert.ok(readFileSync(join(journal.backup,'snapshot.json')).equals(snapshotBefore));
  assert.ok(readFileSync(state).equals(stateBefore));assert.equal(readFileSync(join(f.deploy,'.env'),'utf8'),f.before);
  assert.equal(existsSync(join(journal.backup,'manifest.json')),false);
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
  for(const file of ['restore.mjs','installation.mjs','recovery.mjs'])copyFileSync(new URL('../deploy/'+file,import.meta.url),join(deploy,file));
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
