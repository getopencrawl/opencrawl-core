import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

for(const name of ['up.sh','up-capture.sh'])test(`${name} preserves an unknown old installation until the backed-up upgrade`,()=>{
 const root=mkdtempSync(join(tmpdir(),'opencrawl-upgrade-guard-')),deploy=join(root,'deploy'),bin=join(root,'bin');mkdirSync(deploy);mkdirSync(bin);
 try{
  copyFileSync(new URL('../deploy/'+name,import.meta.url),join(deploy,name));
  const before='COMPOSE_PROJECT_NAME=existing\nOPENCRAWL_S3_SECRET_ACCESS_KEY=existing-fixture-secret\n';writeFileSync(join(deploy,'.env'),before);
  writeFileSync(join(bin,'docker'),'#!/bin/sh\ntouch "$DOCKER_CALLED"\n',{mode:0o700});
  const result=spawnSync('sh',[join(deploy,name)],{encoding:'utf8',env:{PATH:bin+':'+process.env.PATH,DOCKER_CALLED:join(root,'called')}});
  assert.equal(result.status,1);assert.match(result.stderr,/node deploy\/upgrade\.mjs/);
  assert.equal(readFileSync(join(deploy,'.env'),'utf8'),before);assert.equal(existsSync(join(root,'called')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
