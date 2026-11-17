import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {configuration,plan,airbyteValues,prepareAirbyteChart,applicationName} from './install.mts';
const root=dirname(fileURLToPath(import.meta.url));
const input={context:'test',url:'https://opencrawl.example.com',image:{tag:'sha-test'}};
test('release packaging versions both archives without changing source or building images',()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-release-package-'));
  const original=readFileSync(join(root,'opencrawl/Chart.yaml'),'utf8');
  try{
    const manifest=JSON.stringify({manifests:['amd64','arm64'].map(architecture=>({platform:{os:'linux',architecture}}))});
    const stub=join(dir,'registry.mjs');
    writeFileSync(stub,`globalThis.fetch=async url=>{if(String(url).startsWith('https://ghcr.io/token?'))return Response.json({token:'fixture'});if(String(url).startsWith('https://ghcr.io/v2/'))return new Response(${JSON.stringify(manifest)},{headers:{'docker-content-digest':${JSON.stringify('sha256:'+createHash('sha256').update(manifest).digest('hex'))}}});throw Error('Unexpected network request')};`);
    const out=join(dir,'out');
    const p=spawnSync(process.execPath,['--import',stub,join(root,'release-kit.mts'),'--source',root,'--revision','a'.repeat(40),'--version','7.2.3','--out',out],{encoding:'utf8'});
    assert.equal(p.status,0,p.stderr);
    const chart=spawnSync(process.env.HELM||'helm',['show','chart',join(out,'opencrawl-7.2.3.tgz')],{encoding:'utf8'});
    assert.equal(chart.status,0,chart.stderr);assert.match(chart.stdout,/^version: 7\.2\.3$/m);
    const kit=spawnSync('tar',['-xOf',join(out,'opencrawl-selfhost-7.2.3.tgz'),'./opencrawl/Chart.yaml'],{encoding:'utf8'});
    assert.equal(kit.status,0,kit.stderr);assert.match(kit.stdout,/^version: 7\.2\.3$/m);
    assert.equal(JSON.parse(readFileSync(join(out,'release.json'),'utf8')).version,'7.2.3');
    assert.equal(readFileSync(join(root,'opencrawl/Chart.yaml'),'utf8'),original);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('all shipped agent tools parse without installing dependencies',()=>{
  for(const file of ['install.mts','verify.mts','release-kit.mts','runtime/probe.mts']){const r=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
});
test('installation plan bundles all resources and preserves independent external choices',()=>{
  const all=configuration(input);assert.equal(plan(all).steps.length,3);
  const mixed=configuration({...input,databases:{app:{mode:'external',existingSecret:'app-db'}},opensearch:{mode:'external',url:'https://search.test'}});
  assert.equal(mixed.databases.temporal.mode,'bundled');assert.equal(mixed.databases.airbyte.mode,'bundled');assert.equal(mixed.opensearch.mode,'external');
  const external=configuration({...input,postgresql:{enabled:false},databases:{app:{mode:'external',existingSecret:'app-db'}},temporal:{mode:'external',address:'temporal.test:7233'},opensearch:{mode:'external',url:'https://search.test'},objectStorage:{mode:'external',endpoint:'https://s3.test',bucket:'existing',existingSecret:'s3'},airbyte:{mode:'disabled'}});
  assert.equal(plan(external).steps.length,2);assert.equal(plan(external).steps[0].components?.postgresql,false);assert.deepEqual(plan(external).databases,{app:'external'});
});
test('upstream Airbyte references only supplied credentials in bundled and external DB modes',{skip:!process.env.AIRBYTE_CHART},()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-airbyte-contract-'));
  try{
    const capture=join(dir,'keys.json'),stub=join(dir,'stub.mjs');
    writeFileSync(stub,`#!/usr/bin/env node\nimport fs from 'node:fs';if(process.argv.includes('apply')){const x=JSON.parse(fs.readFileSync(0,'utf8'));if(x.kind==='Secret')fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(Object.keys(x.stringData)));}\n`,{mode:0o700});
    const config=join(dir,'instance.json');writeFileSync(config,JSON.stringify(input));
    const run=spawnSync(process.execPath,[join(root,'install.mts'),'--config',config,'--state-dir',join(dir,'state'),'--apply','--through','infrastructure'],{encoding:'utf8',env:{...process.env,KUBECTL:stub,HELM:stub}});assert.equal(run.status,0,run.stderr);
    const generated=new Set(JSON.parse(readFileSync(capture,'utf8')));
    const wrapper=prepareAirbyteChart(dir,readFileSync(process.env.AIRBYTE_CHART!));
    for(const external of [false,true])for(const tls of [false,true]){
      const c=configuration({...input,databases:{airbyte:{...(external?{mode:'external',host:'pg.example',user:'airbyte',name:'airbyte',existingSecret:'external-db'}:{}),tls}}});
      const values=airbyteValues(c,'opencrawl-credentials','postgres','synthetic-test-only'),path=join(dir,'airbyte.json');writeFileSync(path,JSON.stringify({airbyte:values}));
      const render=spawnSync(process.env.HELM||'helm',['template',c.release+'-airbyte',wrapper,'-f',path],{encoding:'utf8',maxBuffer:16*1024*1024});assert.equal(render.status,0,render.stderr);
      const serviceHost=new URL(values.global.airbyteUrl).hostname;assert.ok(render.stdout.includes('name: '+serviceHost+'\n'),'Configured API host must match the upstream Service');
      assert.ok(render.stdout.includes('DATABASE_URL: '+JSON.stringify(values.global.database.jdbcUrl)));
      for(const document of render.stdout.split('\n---'))for(const key of ['DATABASE_URL','CONFIG_DATABASE_REPLICA_URL','POSTGRES_TLS_DISABLE_HOST_VERIFICATION','SQL_TLS_DISABLE_HOST_VERIFICATION'])assert.ok([...document.matchAll(new RegExp('^\\s*- name: '+key+'$','gm'))].length<=1,`Duplicate ${key} breaks Helm upgrades`);
      let checked=0;for(const match of render.stdout.matchAll(/secretKeyRef:\s*\n\s+name: ([^\n]+)\n\s+key: ([^\n]+)/g)){
        const name=match[1].replaceAll('"','').trim(),key=match[2].replaceAll('"','').trim();
        if(name==='opencrawl-credentials'){assert.ok(generated.has(key),`Generated credentials lack upstream key ${key}`);checked++;}
        if(name==='external-db'){assert.ok(['DATABASE_USER','DATABASE_PASSWORD'].includes(key),`Undocumented external key ${key}`);checked++;}
      }
      assert.ok(checked>=8);assert.match(render.stdout,new RegExp('POSTGRES_TLS_ENABLED: "'+String(tls)+'"'));assert.match(render.stdout,/POSTGRES_TLS_DISABLE_HOST_VERIFICATION: "false"/);assert.match(render.stdout,/SQL_TLS_DISABLE_HOST_VERIFICATION: "false"/);
    }
  }finally{rmSync(dir,{recursive:true});}
});
test('invalid external modes, unsafe identifiers, incomplete credentials and wrong context fail before mutation',()=>{
  for(const patch of [{context:''},{temporal:{mode:'typo'}},{postgresql:{enabled:false}},{databases:{app:{name:'db;DROP DATABASE postgres'}}},{databases:{app:{mode:'external'}}},{opensearch:{mode:'external'}},{objectStorage:{mode:'external'}},{airbyte:{mode:'external'}},{unknown:true}])assert.throws(()=>configuration({...input,...patch}));
});
test('every infrastructure toggle combination renders and disabled resources disappear',()=>{
  const dir=mkdtempSync(join(tmpdir(),'opencrawl-chart-test-'));
  try{
    for(let mask=0;mask<16;mask++){
      const keys=['postgresql','temporal','opensearch','objectStorage'];
      const values:any={runtime:{enabled:false}};
      for(let i=0;i<keys.length;i++)values[keys[i]]={enabled:Boolean(mask&(1<<i)),existingSecret:'test'};
      values.postgresql.databases=[{name:'app',user:'app',passwordKey:'APP_DATABASE_PASSWORD'},{name:'temporal',user:'temporal',passwordKey:'TEMPORAL_DATABASE_PASSWORD'},{name:'temporal_visibility',user:'temporal',passwordKey:'TEMPORAL_DATABASE_PASSWORD'}];
      const path=join(dir,'values.json');writeFileSync(path,JSON.stringify(values));
      const p=spawnSync(process.env.HELM||'helm',['template','sample',join(root,'opencrawl'),'-f',path],{encoding:'utf8'});
      assert.equal(p.status,0,p.stderr);
      for(let i=0;i<keys.length;i++){const component=keys[i]==='objectStorage'?'s3':keys[i];assert.equal(p.stdout.includes('name: sample-'+component+'\n'),Boolean(mask&(1<<i)),`${mask}: ${component}`);}
      assert.ok(!p.stdout.includes('kind: Deployment\nmetadata:\n  name: sample-app'));
      assert.ok(!p.stdout.includes('name: sample-activate\n'));
    }
  }finally{rmSync(dir,{recursive:true});}
});
test('application-only release renders with secret references and prevents SQL injection through Helm',()=>{
  const args=['template','sample',join(root,'opencrawl'),'--set','postgresql.enabled=false,temporal.enabled=false,opensearch.enabled=false,objectStorage.enabled=false,runtime.existingSecret=app-secrets,image.tag=sha-test'];
  const p=spawnSync(process.env.HELM||'helm',args,{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/name: sample-app\n/);assert.match(p.stdout,/name: sample-worker\n/);assert.ok(!p.stdout.includes('POSTGRES_PASSWORD'));
  const override='custom-'.repeat(8),custom=configuration({...input,application:{nameOverride:override}});
  const renamed=spawnSync(process.env.HELM||'helm',[...args,'--set-string','nameOverride='+override],{encoding:'utf8'});assert.equal(renamed.status,0,renamed.stderr);
  for(const suffix of ['app','worker'])assert.ok(renamed.stdout.includes('name: '+applicationName(custom)+'-'+suffix+'\n'));
  const bad=spawnSync(process.env.HELM||'helm',['template','sample',join(root,'opencrawl'),'--set','runtime.enabled=false,postgresql.existingSecret=test,objectStorage.existingSecret=test,temporal.existingSecret=test','--set-string','postgresql.databases[0].name=bad;drop','--set','postgresql.databases[0].user=app,postgresql.databases[0].passwordKey=PASSWORD'],{encoding:'utf8'});assert.notEqual(bad.status,0);assert.match(bad.stderr,/pattern/);
});
