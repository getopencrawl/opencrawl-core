import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {cloudSetupScript} from '../src/sessions/cloud-setup.mjs';
test('cloud image setup needs no credential; first hook authenticates and forwards its original stdin',()=>{
 const home=mkdtempSync(join(tmpdir(),'opencrawl-cloud-'));
 try {
  const bin=join(home,'bin'),root=join(home,'.local/share/opencrawl-cloud'),settings=join(home,'.claude/settings.json');
  mkdirSync(bin);mkdirSync(join(root,'node_modules/.bin'),{recursive:true});mkdirSync(join(home,'.claude'));
  writeFileSync(settings,JSON.stringify({theme:'dark',hooks:{Stop:[{hooks:[{type:'command',command:'echo user-hook'}]}]}}));
  writeFileSync(join(bin,'npm'),'#!/bin/sh\nexit 0\n',{mode:0o700});
  const cli=join(root,'node_modules/.bin/opencrawl');
  writeFileSync(cli,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const mode=process.argv[3];
fs.appendFileSync(path.join(process.env.HOME,'calls'),mode+'\\n');
if(mode==='install') {
 if(!process.env.OPENCRAWL_SESSIONS_TOKEN)process.exit(42);
 if(process.env.FAIL_INSTALL)process.exit(43);
 const dir=path.join(process.env.HOME,'.config/opencrawl/capture');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'config.json'),'{}');
} else {fs.writeFileSync(path.join(process.env.HOME,'hook-input'),fs.readFileSync(0));}
`,{mode:0o700});
  const env={...process.env,HOME:home,PATH:bin+':'+process.env.PATH};
  for(const key of ['OPENCRAWL_SESSIONS_TOKEN','OPENCRAWL_CONFIG_HOME','XDG_CONFIG_HOME','CLAUDE_CONFIG_DIR'])delete env[key];
  const script=cloudSetupScript('https://capture.example.com');
  for(let i=0;i<2;i++) {const r=spawnSync('sh',[],{env,input:script,encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
  assert.ok(!existsSync(join(home,'calls')),'image setup must not authenticate or mint installation identity');
  const hooks=JSON.parse(readFileSync(settings)).hooks;
  assert.equal(hooks.SessionStart.length,1);assert.equal(hooks.Stop.length,2);
  const command=hooks.SessionStart[0].hooks[0].command,input='{"session_id":"fresh","hook_event_name":"SessionStart"}\n';
  let r=spawnSync('sh',['-c',command],{env:{...env,OPENCRAWL_SESSIONS_TOKEN:'test',FAIL_INSTALL:'1'},input,encoding:'utf8'});
  assert.equal(r.status,43);assert.ok(!existsSync(join(home,'hook-input')),'failed identity prevents capture');
  r=spawnSync('sh',['-c',command],{env:{...env,OPENCRAWL_SESSIONS_TOKEN:'test'},input,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);assert.equal(readFileSync(join(home,'hook-input'),'utf8'),input);
  assert.equal(readFileSync(join(home,'calls'),'utf8'),'install\ninstall\nhook\n');
  r=spawnSync('sh',['-c',command],{env:{...env,OPENCRAWL_SESSIONS_TOKEN:'test'},input,encoding:'utf8'});
  assert.equal(r.status,0);assert.equal(readFileSync(join(home,'calls'),'utf8'),'install\ninstall\nhook\nhook\n');
 } finally {rmSync(home,{recursive:true,force:true});}
});
