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
  for(const name of ['dev/installer.mts','dev/pins.json','deploy/up.sh','deploy/.env.example'])copyFileSync(join(source,name),join(root,name));
  // Upgrade behavior has its own stateful acceptance suite; this fixture isolates backend selection.
  writeFileSync(join(root,'deploy/upgrade.mjs'),'process.exit(0);\n');
  const log=join(root,'calls');
  writeFileSync(join(root,'bin/docker'),`#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_LOG"\ncase "$1" in inspect) exit 1 ;; info) echo '{"MemTotal":0,"NCPU":0}' ;; esac\n`,{mode:0o755});
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,TEST_LOG:log};
  delete env.COMPOSE_FILE;
  return {root,env,log:()=>existsSync(log)?readFileSync(log,'utf8'):'',
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
  assert.match(f.log(),/compose up -d --build --wait/);assert.equal(readFileSync(path,'utf8'),saved);
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
