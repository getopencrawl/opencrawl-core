import test from 'node:test';
import {snapshot,digest} from '../deploy/recovery.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(options={}){
 const root=mkdtempSync(join(tmpdir(),'opencrawl-full-upgrade-')),deploy=join(root,'deploy'),bin=join(root,'bin');mkdirSync(deploy);mkdirSync(bin);
 for(const file of ['upgrade.mjs','activation.mjs','installation.mjs','recovery.mjs','backup.mjs','legacy-backup.mjs'])copyFileSync(new URL('../deploy/'+file,import.meta.url),join(deploy,file));
 const before='COMPOSE_PROJECT_NAME=existing\nOPENCRAWL_S3_SECRET_ACCESS_KEY=private-fixture-secret\n';writeFileSync(join(deploy,'.env'),before);
 const names=options.stateInit?['app','worker','app-state-ready','database-ready','s3','temporal-db']:['app','worker','temporal-db'];
 const dependencies={app:'app-state-ready:service_completed_successfully',worker:'app:service_healthy','app-state-ready':'database-ready:service_completed_successfully,s3:service_started','database-ready':'temporal-db:service_healthy'};
 const containers=names.map(name=>({Id:name,Image:'sha256:fixture',Config:{Labels:{'com.docker.compose.service':name,'com.docker.compose.project':'existing','com.docker.compose.oneoff':'False',...(options.stateInit&&dependencies[name]?{'com.docker.compose.depends_on':dependencies[name]}:{})},Cmd:['true'],Env:['SECRET=private-fixture-secret']},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},Mounts:[],State:{Running:!name.endsWith('-ready'),Health:{Status:'healthy'}}}));
 writeFileSync(join(bin,'git'),'#!/bin/sh\nprintf "%040d\\n" 1\n',{mode:0o700});
 writeFileSync(join(bin,'docker'),'#!/usr/bin/env node\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2),stateFile=process.env.CALLS+'.state';fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
 const options=JSON.parse(process.env.OPTIONS),state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{oldAvailable:true,tags:{},newRunning:false};
 const save=()=>fs.writeFileSync(stateFile,JSON.stringify(state));
 if(a[0]==='ps')console.log(${JSON.stringify(names.join('\n'))});
 else if(a[0]==='inspect'){const rows=${JSON.stringify(containers)};if(state.newRunning)for(const row of rows)if(['app','worker'].includes(row.Id)){row.Image='sha256:'+'a'.repeat(64);row.Config.Labels['org.opencontainers.image.revision']=options.wrongRevision?'f'.repeat(40):'0'.repeat(39)+'1';if(options.unhealthyWorker&&row.Id==='worker')row.State.Health.Status='unhealthy';if(options.foreignWorker&&row.Id==='worker')row.Config.Labels['com.docker.compose.project']='foreign';}console.log(JSON.stringify(rows));}
 else if(a[0]==='image'&&a[1]==='tag'){if(!state.oldAvailable)process.exit(125);state.tags[a[3]]=a[2];save();}
 else if(a[0]==='image'&&a[1]==='inspect'&&!a.includes('--format'))console.log(JSON.stringify(a.slice(2).map(Id=>({Id,Config:{Labels:{'org.opencontainers.image.revision':options.wrongImageRevision?'f'.repeat(40):'0'.repeat(39)+'1'}}}))));
 else if(a[0]==='image'&&a[1]==='inspect'){const ref=a.at(-1);if(!state.oldAvailable)process.exit(125);console.log(state.tags[ref]||ref);}
 else if(a[0]==='image'&&a[1]==='save'){if(options.failImageSave)process.exit(18);if(!state.oldAvailable)process.exit(125);console.log(JSON.stringify({tags:Object.fromEntries(a.slice(2).map(tag=>[tag,state.tags[tag]]))}));}
 else if(a[0]==='image'&&a[1]==='load'){if(options.failImageLoad)process.exit(125);Object.assign(state.tags,JSON.parse(fs.readFileSync(0,'utf8')).tags);state.oldAvailable=true;save();}
 else if(a.includes('build')){if(options.failBuild!==false)process.exit(17);if(options.loseImagesAfterBuild)state.oldAvailable=false;save();}
 else if(a[0]==='stop'||a[0]==='start'){if(a[0]==='stop'&&options.failStop)process.exit(95);}
 else if(a[0]==='run'){if(!state.oldAvailable)process.exit(125);if(options.failStoreArchive)process.exit(96);console.log('cold-store-archive');}
 else if(a[0]==='compose'){if(a.includes('dist/src/selfhost/activate.mjs')){if(options.failCatchup)process.exit(99);console.log(JSON.stringify({connectorCatchup:{required:false,completed:true,connections:0}}));}if(a.includes('dist/src/sessions/identity-migration.mjs')&&options.failMigration)process.exit(97);if(a.includes('dist/src/state/migrate.mjs')&&a.includes(options.failStateOperation))process.exit(98);if(a.includes('up')&&a.includes('app')){state.newRunning=true;save();}}
 else process.exit(19);
 `,{mode:0o700});
 const runScript=(name,args)=>spawnSync(process.execPath,[join(deploy,name),...args],{encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls'),OPTIONS:JSON.stringify(options)}});
 const run=args=>runScript('upgrade.mjs',args);
 return {root,deploy,before,run,backupRun:args=>runScript('backup.mjs',args),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('upgrade check is read-only and does not disclose persisted credentials',()=>{
 const f=fixture();try{
  const r=f.run(['--check']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).needed,true);
  assert.equal(existsSync(join(f.deploy,'.upgrade')),false);assert.equal(readFileSync(join(f.deploy,'.env'),'utf8'),f.before);
  assert.ok(!r.stdout.includes('private-fixture-secret'));assert.ok(!readFileSync(join(f.root,'calls'),'utf8').includes('stop'));
 }finally{f.cleanup();}
});

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

test('application-state verification precedes every new writer and follows the matched backup',()=>{
 const f=fixture({failBuild:false});try{
  const result=f.run([]);assert.equal(result.status,0,result.stderr);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const stores=calls.findIndex(a=>a[0]==='run'),events=calls.findIndex(a=>a.includes('dist/src/sessions/identity-migration.mjs'));
  const operations=calls.map((a,index)=>({a,index})).filter(({a})=>a.includes('dist/src/state/migrate.mjs'));
  assert.deepEqual(operations.map(({a})=>a[a.indexOf('dist/src/state/migrate.mjs')+1]),['check','migrate','verify']);
  assert.ok(operations.every(({a})=>a.includes('--writers-stopped')&&a.includes('--expect-existing')));
  const start=calls.findIndex(a=>a[0]==='compose'&&a.includes('up')&&a.includes('app'));
  assert.ok(stores<events&&events<operations[0].index&&operations.at(-1).index<start);
 }finally{f.cleanup();}
});

for(const [operation,phase] of [['check','migrated'],['migrate','app-state-checked'],['verify','app-state-migrated']])test(`failed application-state ${operation} keeps writers stopped and resumes the same backup`,()=>{
 const options={failBuild:false,failStateOperation:operation},f=fixture(options);try{
  const result=f.run([]);assert.equal(result.status,1);assert.match(result.stderr,new RegExp('"phase":"'+phase+'"'));
  const journalPath=join(f.deploy,'.upgrade/upgrade.json'),journal=JSON.parse(readFileSync(journalPath,'utf8'));
  const manifest=readFileSync(join(journal.backup,'manifest.json'));
  let calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(!calls.some(a=>a[0]==='compose'&&a.includes('up')&&a.includes('app')));
  assert.ok(calls.some(a=>a[0]==='stop'&&a.includes('app')&&a.includes('worker')));
  delete options.failStateOperation;writeFileSync(join(f.root,'calls'),'');
  const resumed=f.run([]);assert.equal(resumed.status,0,resumed.stderr);
  assert.ok(readFileSync(join(journal.backup,'manifest.json')).equals(manifest));
  assert.equal(JSON.parse(readFileSync(journalPath,'utf8')).phase,'complete');
  calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(!calls.some(a=>a[0]==='image'&&a[1]==='save'),'resume must not replace the recovery point');
  const verify=calls.findIndex(a=>a.includes('dist/src/state/migrate.mjs')&&a.includes('verify'));
  const start=calls.findIndex(a=>a[0]==='compose'&&a.includes('up')&&a.includes('app'));
  assert.ok(verify>=0&&verify<start);
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

test('connector activation failure keeps upgrade incomplete and stops the new writers',()=>{
 const f=fixture({failBuild:false,failCatchup:true});try{
  const result=f.run([]);assert.equal(result.status,1);const journal=JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8'));assert.equal(journal.phase,'healthy');assert.equal(journal.connectorCatchup,undefined);
  const calls=readFileSync(join(f.root,'calls'),'utf8').trim().split('\n').map(JSON.parse);const gate=calls.findIndex(a=>a.includes('dist/src/selfhost/activate.mjs'));assert.ok(gate>0);assert.ok(calls.slice(gate+1).some(a=>a[0]==='stop'&&a.includes('app')&&a.includes('worker')));assert.ok(!result.stdout.includes('"upgrade":"complete"'));
 }finally{f.cleanup();}
});

test('record-startup cannot retain a prior completion after connector revalidation fails',()=>{
 const options={failBuild:false},f=fixture(options);try{
  assert.equal(f.run([]).status,0);options.failCatchup=true;
  const failed=f.run(['--record-startup']);assert.equal(failed.status,1);assert.equal(JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8')).phase,'healthy');
  options.failCatchup=false;const resumed=f.run(['--record-startup']);assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8')).connectorCatchup.completed,true);
 }finally{f.cleanup();}
});

test('record-startup rejects another target and unproven runtime before activation or stopping writers',()=>{
 for(const field of ['wrongImageRevision','unhealthyWorker','foreignWorker','otherTarget']){
  const options={failBuild:false},f=fixture(options);try{
   assert.equal(f.run([]).status,0);const before=readFileSync(join(f.root,'calls'),'utf8');
   if(field==='otherTarget'){const file=join(f.deploy,'.upgrade/upgrade.json'),journal=JSON.parse(readFileSync(file,'utf8'));journal.target='f'.repeat(40);writeFileSync(file,JSON.stringify(journal));}else options[field]=true;
   const result=f.run(['--record-startup']);assert.equal(result.status,1);const added=readFileSync(join(f.root,'calls'),'utf8').slice(before.length);assert.ok(!added.includes('dist/src/selfhost/activate.mjs'));assert.ok(!added.includes('"stop"'));
  }finally{f.cleanup();}
 }
});
