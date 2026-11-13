import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'opencrawl-full-upgrade-')),deploy=join(root,'deploy'),bin=join(root,'bin');mkdirSync(deploy);mkdirSync(bin);
 for(const file of ['upgrade.mjs','installation.mjs','recovery.mjs'])copyFileSync(new URL('../deploy/'+file,import.meta.url),join(deploy,file));
 const before='COMPOSE_PROJECT_NAME=existing\nOPENCRAWL_S3_SECRET_ACCESS_KEY=private-fixture-secret\n';writeFileSync(join(deploy,'.env'),before);
 const containers=['app','worker','temporal-db'].map(name=>({Id:name,Image:'sha256:fixture',Config:{Labels:{'com.docker.compose.service':name,'com.docker.compose.oneoff':'False'},Cmd:['true'],Env:['SECRET=private-fixture-secret']},HostConfig:{RestartPolicy:{Name:'unless-stopped'}},Mounts:[],State:{Running:true}}));
 writeFileSync(join(bin,'git'),'#!/bin/sh\nprintf "%040d\\n" 1\n',{mode:0o700});
 writeFileSync(join(bin,'docker'),'#!/usr/bin/env node\n'+`
 const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CALLS,JSON.stringify(a)+'\\n');
 if(a[0]==='ps')console.log('app\\nworker\\ntemporal-db');
 else if(a[0]==='inspect')console.log(${JSON.stringify(JSON.stringify(containers))});
 else if(a.includes('build'))process.exit(17);
 else process.exit(19);
 `,{mode:0o700});
 const run=args=>spawnSync(process.execPath,[join(deploy,'upgrade.mjs'),...args],{encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls')}});
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
   const r=f.run([]);assert.equal(r.status,1);assert.match(r.stderr,/"phase":"prepared"/);
   assert.equal(readFileSync(join(f.deploy,'.env'),'utf8'),f.before);
   assert.ok(!readFileSync(join(f.root,'calls'),'utf8').includes('stop'));
  }
  assert.equal(JSON.parse(readFileSync(join(f.deploy,'.upgrade/upgrade.json'),'utf8')).phase,'prepared');
 }finally{f.cleanup();}
});
