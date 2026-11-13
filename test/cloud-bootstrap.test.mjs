import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {cloudSetupScript} from '../dist/src/sessions/cloud-setup.mjs';

test('cloud image setup prepares the published CLI without runtime credentials or history import',()=>{
 const home=mkdtempSync(join(tmpdir(),'opencrawl-cloud-'));
 try {
  const bin=join(home,'bin'),root=join(home,'.local/bin');
  mkdirSync(bin);mkdirSync(root,{recursive:true});
  writeFileSync(join(bin,'curl'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(process.env.FAIL_DOWNLOAD)process.exit(44);
fs.writeFileSync(path.join(process.env.HOME,'download-args'),JSON.stringify(args));
fs.writeFileSync(args[args.indexOf('-o')+1],'#!/bin/sh\\nprintf "%s" "$1" > "$HOME/install-version"\\n');
`,{mode:0o700});
  writeFileSync(join(root,'opencrawl'),`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.env.OPENCRAWL_SESSIONS_TOKEN)process.exit(42);
fs.writeFileSync(path.join(process.env.HOME,'calls'),JSON.stringify(process.argv.slice(2)));
if(process.env.FAIL_INSTALL)process.exit(43);
`,{mode:0o700});
  const env={...process.env,HOME:home,PATH:bin+':'+process.env.PATH};
  delete env.OPENCRAWL_SESSIONS_TOKEN;
  const script=cloudSetupScript('https://capture.example.com');
  const r=spawnSync('sh',[],{env,input:script,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const download=JSON.parse(readFileSync(join(home,'download-args')));
  assert.equal(download[1],'https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.sh');
  assert.equal(readFileSync(join(home,'install-version'),'utf8'),'next');
  assert.doesNotMatch(script,/npm |node_modules/,'native cloud preparation must not require Node or npm');
  const args=JSON.parse(readFileSync(join(home,'calls')));
  assert.deepEqual(args.slice(0,2),['collect','install']);
  assert.equal(args[args.indexOf('--api')+1],'https://capture.example.com');
  assert.equal(args[args.indexOf('--harness')+1],'claude-code');
  assert.equal(args[args.indexOf('--backfill')+1],'skip');
  assert.ok(args.includes('--defer-auth'));
  assert.ok(args.includes('--yes'));
  const fail=spawnSync('sh',[],{env:{...env,FAIL_INSTALL:'1'},input:script,encoding:'utf8'});
  assert.equal(fail.status,43,'failed preparation must fail the image setup');
  const unavailable=spawnSync('sh',[],{env:{...env,FAIL_DOWNLOAD:'1'},input:script,encoding:'utf8'});
  assert.equal(unavailable.status,44,'failed downloads must fail before the installer runs');
 }finally{rmSync(home,{recursive:true,force:true});}
});
