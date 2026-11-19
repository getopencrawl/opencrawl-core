import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectCodexHooks,localCodexHookReview,nativeCodexHooks,codexHookReviewMessage} from '../src/capture/codex-hooks.ts';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'opencrawl-hook-review-')),file=join(root,'hooks.json'),config=join(root,'config.toml'),sentinel=join(root,'hook-executed');
 writeFileSync(file,JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'echo unexpected > '+JSON.stringify(sentinel),statusMessage:'OpenCrawl session startup'}]}],Stop:[{hooks:[{type:'command',command:'echo unexpected > '+JSON.stringify(sentinel),statusMessage:'OpenCrawl session capture'}]}]}}));
 writeFileSync(config,'[features]\nhooks = true\n[analytics]\nenabled = false\n');
 const hooks=[['session_start','OpenCrawl session startup'],['stop','OpenCrawl session capture']].map(([event,statusMessage])=>({key:`${file}:${event}:0:0`,sourcePath:file,statusMessage,enabled:true,trustStatus:'untrusted'}));
 const unchanged=()=>[readFileSync(file,'utf8'),readFileSync(config,'utf8')];
 return {root,file,config,hooks,sentinel,unchanged,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('native review counts changed startup and capture hooks; stale hashes never imply trust',async()=>{
 const f=fixture();try{
  writeFileSync(f.config,readFileSync(f.config,'utf8')+`\n[hooks.state.${JSON.stringify(f.hooks[0]!.key)}]\ntrusted_hash = "stale"\n`);
  const before=f.unchanged();expect(localCodexHookReview(f.root)).toMatchObject({state:'unknown',total:2,pending:null});
  const review=await inspectCodexHooks(f.root,async()=>({data:[{errors:[],hooks:[{...f.hooks[0],trustStatus:'modified'},f.hooks[1]]}]}));
  expect(review).toEqual({state:'observed',total:2,pending:2,disabled:0});expect(codexHookReviewMessage(review)).toContain('2 OpenCrawl hooks');expect(f.unchanged()).toEqual(before);
 }finally{f.close();}
});
test('a linked Codex home recognizes the native physical hook path and key',async()=>{
 const f=fixture(),alias=join(f.root,'linked-home');
 try{
  symlinkSync(f.root,alias,process.platform==='win32'?'junction':'dir');
  const file=realpathSync(f.file),hooks=f.hooks.map(h=>({...h,sourcePath:file,key:file+h.key.slice(f.file.length)}));
  expect(await inspectCodexHooks(alias,async()=>({data:[{errors:[],hooks}]}))).toEqual({state:'observed',total:2,pending:2,disabled:0});
 }finally{f.close();}
});
test('trusted current definitions and disabled opt-outs remain distinct',async()=>{
 const f=fixture();try{
  expect(await inspectCodexHooks(f.root,async()=>({data:[{errors:[],hooks:f.hooks.map(h=>({...h,trustStatus:'trusted'}))}]}))).toEqual({state:'observed',total:2,pending:0,disabled:0});
  const review=await inspectCodexHooks(f.root,async()=>({data:[{errors:[],hooks:[{...f.hooks[0],trustStatus:'trusted'}, {...f.hooks[1],enabled:false}]}]}));
  expect(review).toEqual({state:'observed',total:2,pending:0,disabled:1});expect(codexHookReviewMessage(review)).toContain('keep intentional opt-outs');
 }finally{f.close();}
});
test('missing, malformed, unavailable and concurrently changed native inventory stays unknown',async()=>{
 const f=fixture();try{
  for(const query of [async()=>{throw new Error('unavailable');},async()=>({data:[]}),async()=>({data:[{errors:[],hooks:[f.hooks[0]]}]}),async()=>({data:[{errors:[{}],hooks:f.hooks}]})])expect(await inspectCodexHooks(f.root,query)).toMatchObject({state:'unknown',pending:null});
  expect(await inspectCodexHooks(f.root,async()=>{writeFileSync(f.config,readFileSync(f.config,'utf8')+'\n# changed during inspection\n');return {data:[{errors:[],hooks:f.hooks.map(h=>({...h,trustStatus:'trusted'}))}]};})).toMatchObject({state:'unknown',pending:null});
 }finally{f.close();}
});
test.skipIf(process.env.OPENCRAWL_TEST_CODEX_HOOKS!=='1')('real Codex inventory detects an edited trusted fixture without mutating configuration',async()=>{
 const f=fixture();try{
  let before=f.unchanged();expect(await inspectCodexHooks(f.root)).toEqual({state:'observed',total:2,pending:2,disabled:0});expect(f.unchanged()).toEqual(before);
  const inventory=await nativeCodexHooks(f.root) as {data:{hooks:{key:string;currentHash:string}[]}[]};
  // These are synthetic, never-executed fixtures in a disposable home, not user trust.
  writeFileSync(f.config,readFileSync(f.config,'utf8')+inventory.data[0]!.hooks.map(h=>`\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash=${JSON.stringify(h.currentHash)}\n`).join(''));
  before=f.unchanged();expect(await inspectCodexHooks(f.root)).toEqual({state:'observed',total:2,pending:0,disabled:0});expect(f.unchanged()).toEqual(before);
  const hooks=JSON.parse(readFileSync(f.file,'utf8'));hooks.hooks.SessionStart[0].hooks[0].command+=' changed';writeFileSync(f.file,JSON.stringify(hooks));
  before=f.unchanged();expect(await inspectCodexHooks(f.root)).toEqual({state:'observed',total:2,pending:1,disabled:0});expect(f.unchanged()).toEqual(before);expect(existsSync(f.sentinel)).toBe(false);
 }finally{f.close();}
},20000);
