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
  const bin=join(home,'bin'),root=join(home,'.local/share/opencrawl-cloud');
  mkdirSync(bin);mkdirSync(join(root,'node_modules/.bin'),{recursive:true});
  writeFileSync(join(bin,'npm'),`#!${process.execPath}
require('node:fs').writeFileSync(require('node:path').join(process.env.HOME,'npm-args'),JSON.stringify(process.argv.slice(2)));
`,{mode:0o700});
  writeFileSync(join(root,'node_modules/.bin/opencrawl'),`#!${process.execPath}
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
  const install=JSON.parse(readFileSync(join(home,'npm-args')));
  assert.equal(install[0],'install');
  assert.deepEqual(install.filter(arg=>arg.startsWith('@getopencrawl/cli@')),['@getopencrawl/cli@0.4.46'],
   'fresh cloud images must install the CLI with agent skills and bounded capture');
  const args=JSON.parse(readFileSync(join(home,'calls')));
  assert.deepEqual(args.slice(0,2),['collect','install']);
  assert.equal(args[args.indexOf('--api')+1],'https://capture.example.com');
  assert.equal(args[args.indexOf('--harness')+1],'claude-code');
  assert.equal(args[args.indexOf('--backfill')+1],'skip');
  assert.ok(args.includes('--defer-auth'));
  assert.ok(args.includes('--yes'));
  const fail=spawnSync('sh',[],{env:{...env,FAIL_INSTALL:'1'},input:script,encoding:'utf8'});
  assert.equal(fail.status,43,'failed preparation must fail the image setup');
 }finally{rmSync(home,{recursive:true,force:true});}
});
