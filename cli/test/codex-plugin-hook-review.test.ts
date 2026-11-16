import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {pluginHookFiles} from '../src/setup/plugin-hooks.ts';
import {inspectCodexHooks,localCodexHookReview} from '../src/capture/codex-hooks.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
function fixture(){
 const temporary=mkdtempSync(join(tmpdir(),'opencrawl-plugin-review-')),home=realpathSync(temporary),root=join(home,'.codex'),configHome=join(home,'profile'),prior=process.env.OPENCRAWL_CONFIG_HOME;
 process.env.OPENCRAWL_CONFIG_HOME=configHome;
 const api='https://candidate.example',key=hash(api).slice(0,12),name='opencrawl-'+key,pluginId=name+'@opencrawl-cli-'+key,nativeRoot=join(root,'plugins/cache',name,'local'),file=join(nativeRoot,'hooks/hooks.json'),captureFile=join(configHome,'opencrawl/capture/config.json'),config=join(root,'config.toml'),marker=join(nativeRoot,'.opencrawl-setup-plugin.json'),receipt=join(configHome,'opencrawl/setup-plugins/codex',key,'installed.json');
 const write=(path:string,value:unknown)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='string'?value:json(value));};
 const files=pluginHookFiles('codex',{command:[process.execPath],configHome,api,pluginName:name});
 files['.codex-plugin/plugin.json']=json({name,version:'1.0.0',hooks:'./hooks/hooks.json',mcpServers:'./.mcp.json'});
 files['.mcp.json']=json({mcpServers:{opencrawl:{type:'http',url:api+'/mcp'}}});
 const seal=()=>{
  for(const [name,text] of Object.entries(files))write(join(nativeRoot,name),text);
  const digest=hash(json(files));write(marker,{schemaVersion:2,api,client:'codex',pluginName:name,configHome,version:'1.0.0',digest,files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,hash(text)]))});
  write(receipt,{schemaVersion:2,api,client:'codex',pluginName:name,pluginId,digest,directory:nativeRoot,nativeRoot,cachePath:nativeRoot});
 };
 seal();write(config,'[features]\nhooks = true\n');write(captureFile,{schemaVersion:1,hookOwnership:'plugin',harnesses:['codex'],api,installationId:'fixture-install',owner:{tenantId:'fixture-tenant',userId:'fixture-user'},roots:{codex:root}});
 const hooks=Object.entries(JSON.parse(files['hooks/hooks.json']).hooks).flatMap(([event,groups])=>(groups as {hooks:{statusMessage:string}[]}[]).flatMap((group,g)=>group.hooks.map((entry,h)=>({key:`${pluginId}:hooks/hooks.json:${event.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase()}:${g}:${h}`,sourcePath:file,source:'plugin',pluginId,statusMessage:entry.statusMessage,enabled:true,trustStatus:'trusted'}))));
 const unchanged=()=>[...Object.keys(files).map(name=>readFileSync(join(nativeRoot,name),'utf8')),readFileSync(config,'utf8'),readFileSync(captureFile,'utf8'),readFileSync(marker,'utf8'),readFileSync(receipt,'utf8')];
 return {root,nativeRoot,file,files,seal,write,config,captureFile,receipt,hooks,unchanged,close:()=>{if(prior===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=prior;rmSync(temporary,{recursive:true,force:true});}};
}
const query=(hooks:unknown[])=>async()=>({data:[{errors:[],hooks}]});

test('plugin-only enrollment reports native startup, capture and search-context trust without global hooks',async()=>{
 const f=fixture();try{
  const before=f.unchanged();expect(localCodexHookReview(f.root)).toEqual({state:'unknown',total:9,pending:null,disabled:null});
  expect(await inspectCodexHooks(f.root,query(f.hooks))).toEqual({state:'observed',total:9,pending:0,disabled:0});
  const changed=f.hooks.map((hook,i)=>({...hook,trustStatus:i<2?'modified':hook.trustStatus,enabled:i!==2}));
  expect(await inspectCodexHooks(f.root,query(changed))).toEqual({state:'observed',total:9,pending:2,disabled:1});expect(f.unchanged()).toEqual(before);
 }finally{f.close();}
});

test('foreign source, deployment ID, missing receipt and bundle tampering cannot confer native trust',async()=>{
 const f=fixture();try{
  const foreign=f.hooks.map(hook=>({...hook,source:'user',pluginId:'opencrawl@production',sourcePath:join(f.root,'hooks.json')}));
  f.write(join(f.root,'hooks.json'),{hooks:{}});
  expect(await inspectCodexHooks(f.root,query(foreign))).toMatchObject({state:'unknown',pending:null});
  expect(await inspectCodexHooks(f.root,query([...foreign,...f.hooks]))).toMatchObject({state:'observed',pending:0,total:9});
  expect(await inspectCodexHooks(f.root,query(f.hooks.map(hook=>({...hook,pluginId:'opencrawl@another'}))))).toMatchObject({state:'unknown',pending:null});
  rmSync(f.receipt);expect(await inspectCodexHooks(f.root,query(foreign))).toMatchObject({state:'unknown',pending:null});
  f.seal();f.write(join(f.nativeRoot,Object.keys(f.files).find(name=>name.startsWith('scripts/'))!),'tampered runner');
  expect(await inspectCodexHooks(f.root,query(f.hooks))).toMatchObject({state:'unknown',pending:null});
 }finally{f.close();}
});

test('a changed installed bundle needs current native review and concurrent changes remain unknown',async()=>{
 const f=fixture();try{
  const runner=Object.keys(f.files).find(name=>name.startsWith('scripts/'))!;f.files[runner]+='\n';f.seal();
  expect(await inspectCodexHooks(f.root,query(f.hooks.map(hook=>({...hook,trustStatus:'modified'}))))).toEqual({state:'observed',total:9,pending:9,disabled:0});
  expect(await inspectCodexHooks(f.root,async()=>{f.files[runner]+='\n';f.seal();return {data:[{errors:[],hooks:f.hooks}]};})).toMatchObject({state:'unknown',pending:null});
  expect(await inspectCodexHooks(f.root,async()=>{throw new Error('native unavailable');})).toMatchObject({state:'unknown',pending:null});
 }finally{f.close();}
});

test('explicit forward opt-out does not turn startup trust into a recording requirement',async()=>{
 const f=fixture();try{
  const config=JSON.parse(readFileSync(f.captureFile,'utf8'));f.write(f.captureFile,{...config,harnesses:[]});
  expect(await inspectCodexHooks(f.root,async()=>{throw new Error('Native query must not run for recording opt-out');})).toEqual({state:'not_applicable',total:0,pending:0,disabled:0});
 }finally{f.close();}
});


test('plugin review includes pending and disabled search context alongside capture hooks',async()=>{
 const f=fixture();try{
  const before=f.unchanged(),search=f.hooks.find(hook=>hook.statusMessage==='OpenCrawl search context');
  expect(search).toBeDefined();
  const pending=f.hooks.map(hook=>hook===search?{...hook,trustStatus:'untrusted'}:hook);
  expect(await inspectCodexHooks(f.root,query(pending))).toEqual({state:'observed',total:9,pending:1,disabled:0});
  const disabled=pending.map(hook=>hook.key===search!.key?{...hook,enabled:false}:hook);
  expect(await inspectCodexHooks(f.root,query(disabled))).toEqual({state:'observed',total:9,pending:0,disabled:1});
  expect(f.unchanged()).toEqual(before);
 }finally{f.close();}
});
