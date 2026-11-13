import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const checksums=readFileSync(join(root,'dev/node-checksums.txt'),'utf8');
function fixture(t,{os='Linux',arch='aarch64',docker=true,checksum=true,native=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'opencrawl bootstrap ')),bin=join(dir,'test-bin'),dev=join(dir,'dev');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(bin);mkdirSync(dev);
  for(const name of ['up','node-checksums.txt'])copyFileSync(join(root,'dev',name),join(dev,name));
  writeFileSync(join(dev,'installer.mts'),"console.log('TEST_RUNTIME='+JSON.stringify({platform:process.platform,arch:process.arch,version:process.version,args:process.argv.slice(2)}));\n");
  const shim=(name,body)=>writeFileSync(join(bin,name),'#!/bin/sh\nset -eu\n'+body+'\n',{mode:0o755});
  shim('docker',`printf 'docker %s\\n' "$*" >> "$TEST_LOG"\nexit ${docker?0:1}`);
  shim('sudo',`echo sudo >> "$TEST_LOG"\nexit 99`);
  const hostOs=os==='Darwin'?'darwin':'linux',hostArch=['arm64','aarch64'].includes(arch)?'arm64':'x64';
  if(!native){
    shim('uname',`case "$1" in -s) echo '${os}' ;; -m) echo '${arch}' ;; *) exit 98 ;; esac`);
    shim('curl',`printf 'curl %s\\n' "$*" >> "$TEST_LOG"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; printf archive > "$1"; exit 0; fi; shift; done\nexit 98`);
    const hash=`name=$(basename "$1")\nawk -v name="$name" '$2 == name {print $1 "  " name}' "$TEST_CHECKSUMS"`;
    shim('sha256sum',checksum?hash:'echo bad-checksum');
    shim('shasum',`shift 2\n${checksum?hash:'echo bad-checksum'}`);
    shim('tar',`printf 'tar %s\\n' "$*" >> "$TEST_LOG"\n[ "$1" = -xf ] && [ "$3" = -C ]\nmkdir -p "$4/$(dirname "$5")"\ncp "$TEST_NODE" "$4/$5"`);
    writeFileSync(join(dir,'fake-node'),`#!/bin/sh\nif [ "$1" = -p ]; then echo v24.22.2-${hostOs}-${hostArch}; else printf 'INSTALLER %s\\n' "$*"; fi\n`,{mode:0o755});
  }
  const env={...process.env,PATH:bin+':'+(native?process.env.PATH:'/usr/bin:/bin'),TEST_LOG:join(dir,'calls.log'),TEST_CHECKSUMS:join(dev,'node-checksums.txt'),TEST_NODE:join(dir,'fake-node')};
  return {dir,run:(args=['demo','--no-airbyte'])=>spawnSync('/bin/bash',[join(dev,'up'),...args],{env,encoding:'utf8',timeout:native?120000:10000}),log:()=>existsSync(env.TEST_LOG)?readFileSync(env.TEST_LOG,'utf8'):''};
}
test('bootstrap forwards SQLite with the existing startup modes',t=>{
  const f=fixture(t);const r=f.run(['--sqlite','demo','--no-airbyte']);
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/installer\.mts --sqlite demo --no-airbyte/);
});
for(const [os,arch,dist] of [['Linux','x86_64','linux-x64.tar.xz'],['Linux','aarch64','linux-arm64.tar.xz'],['Darwin','x86_64','darwin-x64.tar.gz'],['Darwin','arm64','darwin-arm64.tar.gz']]){
  test(`bootstrap chooses the verified ${dist} archive and preserves mode flags`,t=>{
    const f=fixture(t,{os,arch});const r=f.run();assert.equal(r.status,0,r.stderr);
    assert.ok(f.log().includes('https://nodejs.org/dist/v24.22.2/node-v24.22.2-'+dist));
    assert.match(r.stdout,/INSTALLER .*installer\.mts demo --no-airbyte/);
    assert.deepEqual(readdirSync(join(f.dir,'.opencrawl-dev')),['bin']);
    assert.doesNotMatch(f.log(),/sudo/);
  });
}
test('macOS with unavailable Docker stops before sudo, downloads or installation state',t=>{
  const f=fixture(t,{os:'Darwin',arch:'arm64',docker:false});const r=f.run();
  assert.equal(r.status,1);assert.match(r.stderr,/Install and start Docker Desktop or Colima/);
  assert.doesNotMatch(f.log(),/sudo|curl|tar/);assert.equal(existsSync(join(f.dir,'.opencrawl-dev')),false);
});
test('unsupported architecture fails before touching Docker or installation state',t=>{
  const f=fixture(t,{arch:'armv7l'});const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/ARM64 processors/);
  assert.equal(f.log(),'');assert.equal(existsSync(join(f.dir,'.opencrawl-dev')),false);
});
test('a corrupt download is never executed and its temporary files are removed',t=>{
  const f=fixture(t,{checksum:false});const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/checksum mismatch/);
  assert.doesNotMatch(r.stdout,/INSTALLER/);assert.doesNotMatch(f.log(),/tar /);
  assert.deepEqual(readdirSync(join(f.dir,'.opencrawl-dev')),['bin']);
  assert.equal(existsSync(join(f.dir,'.opencrawl-dev/bin/node')),false);
});
test('a cached runtime for another architecture fails without deleting existing data',t=>{
  const f=fixture(t);const bin=join(f.dir,'.opencrawl-dev/bin');mkdirSync(bin,{recursive:true});
  writeFileSync(join(bin,'node'),'#!/bin/sh\necho v24.22.2-linux-x64\n',{mode:0o755});
  const sentinel=join(f.dir,'.opencrawl-dev/keep.txt');writeFileSync(sentinel,'existing data');
  const r=f.run();assert.equal(r.status,1);assert.match(r.stderr,/Cached Node.js runtime does not match/);
  assert.equal(readFileSync(sentinel,'utf8'),'existing data');assert.doesNotMatch(f.log(),/curl|tar/);
});
test('every supported host has architecture-matched pinned connector tools',()=>{
  const pins=JSON.parse(readFileSync(join(root,'dev/pins.json'),'utf8'));
  assert.deepEqual(Object.keys(pins.platforms).sort(),['darwin-arm64','darwin-x64','linux-arm64','linux-x64']);
  for(const [host,tools] of Object.entries(pins.platforms)){
    const [os,arch]=host.replace('-x64','-amd64').split('-');
    for(const pin of Object.values(tools)){assert.match(pin.sha256,/^[a-f0-9]{64}$/);assert.ok(pin.url.startsWith('https://'));}
    assert.ok(tools.kind.url.endsWith(`kind-${os}-${arch}`));
    assert.ok(tools.kubectl.url.endsWith(`/bin/${os}/${arch}/kubectl`));
    assert.equal(tools.helm.member,`${os}-${arch}/helm`);
  }
  assert.equal(checksums.trim().split('\n').length,4);
});
test('native host downloads, verifies and executes its real pinned runtime',{
  skip:process.env.OPENCRAWL_TEST_BOOTSTRAP_DOWNLOAD!=='1',timeout:150000,
},t=>{
  const f=fixture(t,{native:true});const r=f.run();assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout.split('\n').find(line=>line.startsWith('TEST_RUNTIME=')).slice('TEST_RUNTIME='.length));
  assert.deepEqual(result,{platform:process.platform,arch:process.arch,version:'v24.22.2',args:['demo','--no-airbyte']});
});

test('operator upgrade bootstrap provides its verified runtime without creating a development installation',t=>{
 const f=fixture(t,{docker:false});const r=f.run(['--node-runtime']);assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout.trim(),realpathSync(join(f.dir,'deploy/.upgrade/bin/node')));
 assert.equal(existsSync(join(f.dir,'.opencrawl-dev')),false);
 assert.doesNotMatch(r.stdout,/INSTALLER/);
});
