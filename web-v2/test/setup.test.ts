import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {clientSummary,historyLabel,setupCommands,pluginLabel,mcpLabel,clientNeedsAgent} from '../src/application/setup.tsx';
import type {SetupStatus} from '../../src/application/types.mjs';

type Client=SetupStatus['installations'][number]['clients'][number];
const client:Client={client:'codex',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'trusted',mcp:{state:'authenticated'},proof:{state:'verified'},humanTasks:[]};
test('past verification does not hide disabled recording, removed plugins, or outstanding human actions',()=>{
  assert.equal(clientSummary({...client,forward:false}).label,'Future recording off');
  assert.equal(clientSummary({...client,installed:false,forward:false,history:'import',mcp:{state:'pending'},proof:{state:'not_selected'}}).label,'History only');
  assert.equal(clientSummary({...client,humanTasks:[{id:'auth',kind:'mcp_auth',client:'codex',title:'Sign in',instruction:'Use native MCP authentication.'}]}).label,'Continue in your agent');
  assert.equal(clientSummary({...client,history:'import',historyProgress:{state:'failed',completed:7,total:20}}).tone,'danger');
  assert.equal(clientSummary({...client,history:'skip',historyProgress:{state:'failed',completed:7,total:20}}).label,'Verified');
});
test('native MCP and capture evidence remain visible before CLI activation is reported',()=>{
  const observed={...client,installed:false,captureObservedAt:'2026-11-15T00:00:00Z'};
  assert.equal(clientSummary(observed).label,'Session searchable');
  assert.equal(pluginLabel(observed),'Activation not reported');
  assert.equal(mcpLabel(observed),'Connected');
  assert.equal(clientSummary({...observed,proof:{state:'waiting_index'}}).label,'Waiting for search');
  assert.equal(mcpLabel({...observed,mcp:{state:'pending'}}),'Sign-in required');
  const searchOnly:Client={...observed,forward:false,mcp:{state:'observed'},proof:{state:'not_selected'}};
  assert.equal(clientSummary(searchOnly).label,'Future recording off');
  assert.equal(mcpLabel(searchOnly),'Connection observed, capture not selected');
  assert.equal(pluginLabel(searchOnly),'Activation not reported');
  assert.equal(clientNeedsAgent(searchOnly),false);
  assert.equal(clientNeedsAgent(observed),false);
  const unbound={...observed,mcp:{state:'observed' as const}};
  assert.equal(clientNeedsAgent(unbound),true);
  assert.equal(clientSummary(unbound).label,'MCP verification pending');
});
test('prepared plugin files have an activation step without becoming installed or hiding live evidence',()=>{
  const prepared:Client={...client,client:'cursor',installed:false,pluginState:'prepared',mcp:{state:'pending'},proof:{state:'pending'}};
  assert.equal(clientSummary(prepared).label,'Activation pending');
  assert.equal(pluginLabel(prepared),'Files ready, activation not reported');
  assert.equal(clientNeedsAgent(prepared),true);
  assert.equal(clientSummary({...prepared,history:'import'}).label,'Activation pending');
  const searchOnly={...prepared,forward:false,proof:{state:'not_selected' as const}};
  assert.equal(mcpLabel(searchOnly),'Sign-in required');assert.equal(clientNeedsAgent(searchOnly),true);
  assert.equal(clientNeedsAgent({...searchOnly,mcp:{state:'observed'}}),false);
  const verified={...prepared,mcp:client.mcp,proof:client.proof};
  assert.equal(clientSummary(verified).label,'Session searchable');assert.equal(clientNeedsAgent(verified),false);
  assert.equal(pluginLabel(verified),'Files ready, activation not reported');assert.equal(verified.installed,false);
  const legacy={...prepared,pluginState:undefined};
  assert.equal(pluginLabel(legacy),'Installation not reported');assert.equal(clientSummary(legacy).label,'Installation not reported');
  assert.equal(pluginLabel({...legacy,pluginState:'not_selected'}),'Not selected');
  assert.equal(clientNeedsAgent({...searchOnly,pluginState:'error'}),true);
});
test('history import progress stays distinct from live session verification',()=>{
  assert.equal(historyLabel({...client,history:'import',proof:{state:'pending'},historyProgress:{state:'complete',completed:12,total:12}}),'Import complete, 12 of 12 processed');
  assert.equal(clientSummary({...client,proof:{state:'waiting_index'}}).label,'Waiting for search');
  assert.equal(historyLabel({...client,history:'skip',historyProgress:{state:'complete',completed:12,total:12}}),'Not selected');
});
test('setup and agent handoff target the selected server with shell-safe arguments',()=>{
  const commands=setupCommands('http://[::1]:4310/mcp');
  assert.equal(commands.setup,"opencrawl setup --api 'http://[::1]:4310'");
  assert.ok(commands.handoff.includes("--api 'http://[::1]:4310' --local --json"));
  assert.ok(commands.handoff.includes("MCP connection at http://[::1]:4310/mcp"));
  assert.ok(!commands.setup.includes('app.getopencrawl.com'));
  assert.ok(commands.handoff.includes('opencrawl setup status'));
  assert.ok(commands.handoff.includes('--client CLIENT --json'));
  assert.ok(commands.handoff.includes('expect not_selected with no capture required'));
  assert.ok(commands.handoff.includes('native installation_status MCP tool'));
  assert.ok(commands.handoff.includes('native verify_installation with its proof.id as proofId'));
  assert.ok(commands.handoff.includes('fallback only when shell network access is normally authorized'));
});

test('explicit start and CLI overrides stay paired and replace every executable handoff',()=>{
  const start='sh /private/preview/install-012345.sh && "/private/preview/opencrawl" setup';
  for(const windows of [false,true]){
    const commands=setupCommands('https://preview.example/mcp',windows,start,'"/private/preview/opencrawl"');
    assert.equal(commands.start,start);
    assert.equal(commands.setup,'"/private/preview/opencrawl" setup --api \'https://preview.example\'');
    assert.ok(commands.handoff.includes('"/private/preview/opencrawl" setup status'));
    assert.ok(commands.handoff.includes('"/private/preview/opencrawl" verify-installation'));
    assert.ok(commands.handoff.includes('--client CLIENT --json'));
    assert.doesNotMatch(commands.start,/raw\.githubusercontent\.com|\/main\/|latest/);
  }
  assert.equal(setupCommands('https://preview.example/mcp',false,'  ',' ').setup,"opencrawl setup --api 'https://preview.example'");
  assert.throws(()=>setupCommands('https://preview.example/mcp',false,start),/configured together/);
  assert.throws(()=>setupCommands('https://preview.example/mcp',false,undefined,'private-cli'),/configured together/);
});

function shellFixture(run:(directory:string,env:NodeJS.ProcessEnv,trace:string)=>void) {
  const directory=mkdtempSync(join(tmpdir(),'opencrawl-setup-command-')),bin=join(directory,'bin'),trace=join(directory,'trace');mkdirSync(bin);
  writeFileSync(join(bin,'opencrawl'),'#!/bin/sh\nprintf "released %s\n" "$*" >> "$TRACE"\n',{mode:0o700});
  try{run(directory,{...process.env,HOME:directory,PATH:bin+':/usr/bin:/bin',TRACE:trace},trace);}finally{rmSync(directory,{recursive:true,force:true});}
}
test('failed installer download or execution never invokes a preexisting CLI',{skip:process.platform==='win32'},()=>{
  for(const curl of ['printf "exit 0\n"; exit 22','printf "exit 7\n"'])shellFixture((directory,env,trace)=>{
    writeFileSync(join(directory,'bin/curl'),'#!/bin/sh\n'+curl+'\n',{mode:0o700});
    const result=spawnSync('/bin/sh',['-c',setupCommands('https://selected.example/mcp').start],{env,encoding:'utf8'});
    assert.notEqual(result.status,0);assert.equal(existsSync(trace),false,'an existing CLI must not run after installation failure');
  });
});
test('successful default installation invokes setup exactly once',{skip:process.platform==='win32'},()=>shellFixture((directory,env,trace)=>{
  writeFileSync(join(directory,'bin/curl'),'#!/bin/sh\nprintf "exit 0\n"\n',{mode:0o700});
  const result=spawnSync('/bin/sh',['-c',setupCommands('https://selected.example/mcp').start],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(trace,'utf8'),'released setup --api https://selected.example\n');
}));
test('private full start executes exactly once and never falls through to the released CLI',{skip:process.platform==='win32'},()=>shellFixture((directory,env,trace)=>{
  const privateCli=join(directory,'private-cli');writeFileSync(privateCli,'#!/bin/sh\nprintf "private %s\n" "$*" >> "$TRACE"\n',{mode:0o700});
  const prefix="'"+privateCli.replace(/'/g,"'\\''")+"'",start=prefix+' setup --api https://preview.example';
  const command=setupCommands('https://preview.example/mcp',false,start,prefix);
  const result=spawnSync('/bin/sh',['-c',command.start],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(trace,'utf8'),'private setup --api https://preview.example\n');
  rmSync(trace);const failure=setupCommands('https://preview.example/mcp',false,'false && '+start,prefix);
  assert.notEqual(spawnSync('/bin/sh',['-c',failure.start],{env}).status,0);assert.equal(existsSync(trace),false);
}));
const powershellAvailable=spawnSync('pwsh',['--version'],{stdio:'ignore'}).status===0;
test('PowerShell download and installer failures stop before setup',{skip:!powershellAvailable},()=>{
  for(const download of ["throw 'fixture download failed'","return '$global:LASTEXITCODE = 7'"]){
    const directory=mkdtempSync(join(tmpdir(),'opencrawl-setup-powershell-')),trace=join(directory,'trace'),literal="'"+trace.replace(/'/g,"''")+"'";
    try{
      const script=`function Invoke-RestMethod { ${download} }\nfunction opencrawl { [System.IO.File]::WriteAllText(${literal}, 'ran') }\n${setupCommands('https://selected.example/mcp',true).start}`;
      const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8'});
      assert.notEqual(result.status,0);assert.equal(existsSync(trace),false);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});
