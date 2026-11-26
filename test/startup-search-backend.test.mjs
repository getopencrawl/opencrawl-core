import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('../',import.meta.url));
function fixture(t){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'opencrawl-startup-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const name of ['dev','deploy','bin'])mkdirSync(join(root,name));
  for(const name of ['dev/installer.mts','dev/airbyte-routes.mts','dev/pins.json','deploy/up.sh','deploy/.env.example'])copyFileSync(join(source,name),join(root,name));
  writeFileSync(join(root,'dev/up'),'#!/bin/sh\nprintf \"%s\\n\" \"$TEST_NODE_RUNTIME\"\n',{mode:0o755});
  writeFileSync(join(root,'bin/git'),'#!/bin/sh\nprintf \"%040d\\n\" 1\n',{mode:0o755});
  const log=join(root,'calls');
  writeFileSync(join(root,'bin/docker'),`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_LOG,args.join(' ')+'\\n');fs.appendFileSync(process.env.TEST_COMMAND_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='inspect')process.exit(1);
if(args[0]==='info')console.log(JSON.stringify({MemTotal:0,NCPU:0}));
if(args[0]==='compose'&&args[1]==='build'&&process.env.TEST_FAIL_BUILD==='1')process.exit(17);
if(args[0]==='compose'&&args[1]==='up'&&process.env.TEST_REJECT_SHARED_BUILD==='1'){
 let build=false;for(const arg of args.slice(2)){if(arg==='--')break;if(arg==='--build')build=true;if(arg.startsWith('--build='))build=['true','1','t','T','TRUE','True'].includes(arg.slice(8));}
 if(build){console.error('parallel shared-tag export rejected');process.exit(73);}
}
`,{mode:0o755});
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,TEST_LOG:log,TEST_COMMAND_LOG:join(root,'commands.jsonl'),TEST_NODE_RUNTIME:process.execPath};
  delete env.COMPOSE_FILE;
  return {root,env,log:()=>existsSync(log)?readFileSync(log,'utf8'):'',
    commands:()=>existsSync(env.TEST_COMMAND_LOG)?readFileSync(env.TEST_COMMAND_LOG,'utf8').trim().split('\n').map(JSON.parse):[],
    dev:args=>spawnSync(process.execPath,[join(root,'dev/installer.mts'),...args],{env,encoding:'utf8',timeout:10000}),
    deploy:args=>spawnSync('/bin/sh',[join(root,'deploy/up.sh'),...args],{env,encoding:'utf8',timeout:10000})};
}

test('development startup saves SQLite and uses its profile for status and stop without repeating the flag',t=>{
  const f=fixture(t),state=join(f.root,'.opencrawl-dev/state.json');
  const initial=f.dev(['--sqlite','--no-airbyte']);
  assert.equal(initial.status,1);assert.match(initial.stderr,/Allocate at least/); // No real containers in this unit test.
  assert.equal(JSON.parse(readFileSync(state)).searchBackend,'sqlite');
  writeFileSync(join(f.root,'.opencrawl-dev/compose.env'),'');
  writeFileSync(join(f.root,'.opencrawl-dev/compose.json'),'{}');
  const status=f.dev(['status']);assert.equal(status.status,0,status.stderr);assert.match(status.stdout,/Search: SQLite FTS5/);
  const stop=f.dev(['stop']);assert.equal(stop.status,0,stop.stderr);
  const calls=f.log().split('\n').filter(line=>line.startsWith('compose '));
  assert.equal(calls.length,2);
  for(const line of calls)assert.ok(line.includes('-f '+join(f.root,'deploy/compose.sqlite.yaml')));
  assert.equal(JSON.parse(readFileSync(state)).searchBackend,'sqlite');
});

test('development startup preserves a legacy OpenSearch installation when SQLite is requested',t=>{
  const f=fixture(t);f.dev(['--no-airbyte']);
  const path=join(f.root,'.opencrawl-dev/state.json'),state=JSON.parse(readFileSync(path));
  delete state.searchBackend;writeFileSync(path,JSON.stringify(state));
  const before=readFileSync(path,'utf8'),calls=f.log(),result=f.dev(['--sqlite','--no-airbyte']);
  assert.equal(result.status,1);assert.match(result.stderr,/changing an existing index requires a migration/);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.log(),calls);
});

for(const args of [['--sqlite','--no-airbyte'],['--no-airbyte','--sqlite']])test(`deployment startup persists SQLite with flags ${args.join(' ')}`,t=>{
  const f=fixture(t),path=join(f.root,'deploy/.env');
  const initial=f.deploy(args);assert.equal(initial.status,0,initial.stderr);
  const saved=readFileSync(path,'utf8');assert.match(saved,/^COMPOSE_FILE=compose.yaml:compose.sqlite.yaml$/m);
  assert.doesNotMatch(f.log(),/compose up/);
  const resume=f.deploy(['--no-airbyte']);assert.equal(resume.status,0,resume.stderr);
  assert.match(f.log(),/compose build --build-arg OPENCRAWL_SOURCE_REVISION=0{39}1 app/);assert.match(f.log(),/compose up -d --no-build --wait/);assert.equal(readFileSync(path,'utf8'),saved);
  const explicit=f.deploy(args);assert.equal(explicit.status,0,explicit.stderr);assert.equal(readFileSync(path,'utf8'),saved);
});

test('deployment startup refuses to replace an existing OpenSearch profile or conflicting Compose selection',t=>{
  const f=fixture(t),path=join(f.root,'deploy/.env');
  assert.equal(f.deploy(['--no-airbyte']).status,0);
  const before=readFileSync(path,'utf8'),calls=f.log(),result=f.deploy(['--sqlite']);
  assert.equal(result.status,1);assert.match(result.stderr,/changing its index requires a migration/);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.log(),calls);
  f.env.COMPOSE_FILE='custom.yaml';
  const conflict=f.deploy(['--sqlite']);assert.equal(conflict.status,1);assert.match(conflict.stderr,/conflicts/);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(f.log(),calls);
});

test('deployment builds its shared image once before starting services',t=>{
  const f=fixture(t);assert.equal(f.deploy(['--no-airbyte']).status,0);f.env.TEST_REJECT_SHARED_BUILD='1';
  const result=f.deploy(['--no-airbyte','--scale','worker=2','--no-recreate','app','worker']);assert.equal(result.status,0,result.stderr);
  assert.deepEqual(f.commands().filter(args=>args[1]!=='config').slice(0,2),[
    ['compose','build','--build-arg','OPENCRAWL_SOURCE_REVISION='+'0'.repeat(39)+'1','app'],
    ['compose','up','-d','--no-build','--wait','--wait-timeout','600','--scale','worker=2','--no-recreate','app','worker'],
  ]);
});

test('bundled credential bootstrap checks the effective named volume before creating it',t=>{
  const f=fixture(t);
  writeFileSync(join(f.root,'bin/docker'),`#!${process.execPath}
if(process.argv.includes('config'))process.stdout.write(process.env.TEST_MODEL);
else if(process.argv.includes('ls')){if(process.env.TEST_DENIED)process.exit(1);process.stdout.write(process.env.TEST_EXISTING);}
`,{mode:0o755});
  const model=['name: opencrawl','services:','  s3:','    command:','      - mini','      - -dir=/data','      - -bucket=opencrawl',
    '    image: chrislusf/seaweedfs:4.52','    volumes:','      - type: volume','        source: s3','        target: /data',
    'volumes:','  s3:','    name: opencrawl_s3'].join('\n');
  const probe=(overrides={})=>spawnSync('/bin/sh',[join(f.root,'deploy/up.sh'),'--check-fresh-credential-volume'],
    {encoding:'utf8',env:{...f.env,TEST_MODEL:model,TEST_EXISTING:'',...overrides}}).stdout;
  assert.equal(probe(),'1');
  assert.equal(probe({TEST_EXISTING:'opencrawl_s3'}),'');
  assert.equal(probe({TEST_DENIED:'1'}),'');
  assert.equal(probe({TEST_MODEL:model.replace('type: volume','type: bind')}),'');
  assert.equal(probe({TEST_MODEL:model.replace('name: opencrawl_s3','name: retained_archive')}),'');
});

test('a failed shared-image build never starts services',t=>{
  const f=fixture(t);assert.equal(f.deploy([]).status,0);f.env.TEST_FAIL_BUILD='1';
  const result=f.deploy([]);assert.equal(result.status,17,result.stderr);
  assert.deepEqual(f.commands(),[['compose','build','--build-arg','OPENCRAWL_SOURCE_REVISION='+'0'.repeat(39)+'1','app']]);
});

for(const [args,build,flag] of [
  [['--build'],true,'--no-build'],[['--build=false'],false,'--build=false'],[['--no-build'],false,'--no-build'],
  [['--build=false','--no-build'],false,'--no-build'],[['--build','--build=false'],false,'--build=false'],
  [['--build=false','--build'],true,'--no-build'],[['--no-build','--no-build=false'],true,'--no-build'],
  [['--build=0','--no-build=1'],false,'--no-build'],[['--','--build=false'],true,'--no-build'],
])test('deployment preserves Compose build selection: '+args.join(' '),t=>{
  const f=fixture(t);assert.equal(f.deploy([]).status,0);f.env.TEST_REJECT_SHARED_BUILD='1';
  const result=f.deploy(args);assert.equal(result.status,0,result.stderr);
  const commands=f.commands();assert.equal(commands.filter(args=>args[1]==='build').length,Number(build));
  const forwarded=args.includes('--')?args:[];
  assert.deepEqual(commands.find(args=>args[1]==='up'),['compose','up','-d',flag,'--wait','--wait-timeout','600',...forwarded]);
});

test('explicit contradictory Compose build flags fail before any build',t=>{
  const f=fixture(t);assert.equal(f.deploy([]).status,0);
  const result=f.deploy(['--build','--no-build']);assert.notEqual(result.status,0);assert.match(result.stderr,/incompatible/);
  assert.deepEqual(f.commands(),[]);
});

test('headless installation starts a fresh workspace in one invocation and reuses the private first-admin password on retry', t => {
  const f = fixture(t);
  const install = () => {
    const result = f.deploy(['--headless']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /setup|first-run/i);
    assert.deepEqual(f.commands().at(-1), ['compose', 'exec', '-T', 'app', 'node', 'deploy/first-admin.mjs']);
    return readFileSync(join(f.root, 'deploy/.state/first-admin-password'), 'utf8');
  };
  const password = install();
  assert.match(password,/^[a-f0-9]{48}$/);
  const config = readFileSync(join(f.root, 'deploy/.env'),'utf8');
  assert.match(config,/^OPENCRAWL_URL=http:\/\/localhost:8092$/m);
  assert.match(config,/^OPENCRAWL_AIRBYTE_ENABLED=false$/m);
  assert.equal(install(),password);
  assert.ok(!f.log().includes(password));
});
