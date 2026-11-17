import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {stableCandidate,checksPassed,gates,selectRelease,versionedChart,versionParts,artifactNames,checksums,verifyArtifactBytes,publishDraft,verifyPublic,type Run,type Release,type GitHub,type Plan} from './release.mts';

const repo='getopencrawl/opencrawl-core',a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40),unrelated='d'.repeat(40);
const ancestor=(x:string,y:string)=>[a,b,c].includes(x)&&[a,b,c].includes(y)&&[a,b,c].indexOf(x)<=[a,b,c].indexOf(y);
const release=(version='0.1.0',revision=a,patch:Partial<Release>={}):Release=>({id:1,tag_name:'helm-v'+version,target_commitish:revision,draft:false,prerelease:false,assets:[],...patch});
const baseline=[release()];
const runs=():Run[]=>gates.map((name,i)=>({id:i+1,path:'.github/workflows/'+name,event:'push',head_branch:'main',head_sha:b,head_repository:{full_name:repo},status:'completed',conclusion:'success'}));
test('only exact-source trusted main runs satisfy every gate; newest reruns supersede old success',()=>{
  assert.equal(checksPassed(runs(),b,repo),true);
  for(let i=0;i<gates.length;i++){
    assert.equal(checksPassed(runs().filter((_,j)=>i!==j),b,repo),false);
    for(const patch of [{status:'in_progress',conclusion:null},{conclusion:'failure'},{event:'pull_request'},{head_branch:'feature'},{head_sha:a},{head_repository:{full_name:'stranger/fork'}}]){
      const changed=runs();changed[i]={...changed[i]!,...patch};assert.equal(checksPassed(changed,b,repo),false);
    }
  }
  assert.equal(checksPassed([...runs(),{...runs()[0]!,id:100,conclusion:'failure'}],b,repo),false);
  for(const name of ['cli.yml','helm.yml'])assert.equal(checksPassed([...runs(),{...runs()[0]!,id:100,path:'.github/workflows/'+name,status:'in_progress'}],b,repo),false);
});
test('automatic patches follow semantic version order and ignore other product releases',()=>{
  assert.equal(selectRelease(baseline,b,undefined,ancestor).version,'0.1.1');
  const history=[release('0.9.9'),release('0.10.0'),release('9.0.0',a,{prerelease:true}),release('50.0.0',a,{tag_name:'cli-v50.0.0'})];
  assert.equal(selectRelease(history,b,undefined,ancestor).version,'0.10.1');
  assert.equal(selectRelease([release('2.0.0')],b,undefined,ancestor).version,'2.0.1');
});
test('duplicate events and late completions never allocate another patch or regress source',()=>{
  assert.deepEqual(selectRelease(baseline,a,undefined,ancestor),{action:'verify',revision:a,version:'0.1.0'});
  assert.equal(selectRelease([release('0.1.1',c)],b,undefined,ancestor).action,'skip');
  assert.throws(()=>selectRelease(baseline,unrelated,undefined,ancestor),/descend/);
  assert.throws(()=>selectRelease([],b,undefined,ancestor),/baseline/);
  assert.throws(()=>selectRelease(baseline,'main',undefined,ancestor),/immutable/);
});
test('manual releases allow only the next minor or major and are idempotent by explicit version',()=>{
  for(const version of ['0.2.0','1.0.0'])assert.equal(selectRelease(baseline,b,version,ancestor).version,version);
  for(const version of ['0.1.1','0.1.0','0.3.0','1.1.0','2.0.0','0.2.1','0.2.0-rc.1','00.2.0'])assert.throws(()=>selectRelease(baseline,b,version,ancestor));
  assert.equal(selectRelease([release('0.2.0',b),...baseline],b,'0.2.0',ancestor).action,'verify');
  assert.throws(()=>selectRelease([release('0.2.0',b),...baseline],c,'0.2.0',ancestor),/another source/);
});
test('an interrupted draft reserves its version and source until that original publication resumes',()=>{
  const draft=release('0.1.1',b,{draft:true,body:`<!-- opencrawl-helm 0.1.1 ${b} -->`});
  assert.equal(selectRelease([...baseline,draft],b,undefined,ancestor).version,'0.1.1');
  assert.throws(()=>selectRelease([...baseline,draft],c,undefined,ancestor),/reserved/);
  assert.throws(()=>selectRelease([...baseline,draft],b,'0.2.0',ancestor),/unfinished/);
  assert.throws(()=>selectRelease([...baseline,{...draft,body:'unowned draft'}],b,undefined,ancestor),/reserved/);
  assert.throws(()=>selectRelease([...baseline,{...draft,prerelease:true}],b,undefined,ancestor),/reserved/);
});
test('staged chart version changes preserve the runtime version and reject malformed versions',()=>{
  const chart='apiVersion: v2\nversion: 0.1.0\nappVersion: "0.4.1"\n';
  assert.equal(versionedChart(chart,'0.2.3'),'apiVersion: v2\nversion: 0.2.3\nappVersion: "0.4.1"\n');
  for(const v of ['1.2','1.2.3\n','1.2.3+meta','1.2.3-rc.1','01.2.3'])assert.throws(()=>versionParts(v));
  assert.throws(()=>versionedChart(chart+'version: 0.1.1\n','0.1.2'));
});

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const plan:Plan={action:'publish',revision:b,version:'0.1.1'};
function artifacts():Map<string,Buffer>{
  const files=new Map(artifactNames('0.1.1').filter(n=>n!=='SHA256SUMS').map(n=>[n,Buffer.from(n==='release.json'?JSON.stringify({version:'0.1.1',revision:b}):n)]));
  files.set('SHA256SUMS',Buffer.from([...files].map(([name,bytes])=>hash(bytes)+'  '+name).join('\n')+'\n'));
  return files;
}
class FakeGitHub implements GitHub{
  draft:Release|undefined;uploaded=new Map<string,Buffer>();published=0;failUpload=false;corrupt=false;assetId=10;
  async request<T>(path:string,method='GET',body?:unknown):Promise<T>{
    if(path==='releases'&&method==='POST'){this.draft={id:9,assets:[],prerelease:false,...body as Omit<Release,'id'|'assets'|'prerelease'>};return structuredClone(this.draft) as T;}
    assert.ok(this.draft);
    if(method==='DELETE'){this.draft.assets=this.draft.assets.filter(a=>'releases/assets/'+a.id!==path);return undefined as T;}
    assert.equal(path,'releases/9');
    if(method==='PATCH'){assert.deepEqual(body,{draft:false,make_latest:'false'});this.draft.draft=false;this.published++;}
    return structuredClone(this.draft) as T;
  }
  async upload(id:number,name:string,bytes:Buffer):Promise<void>{
    assert.equal(id,9);assert.ok(this.draft?.draft);
    if(this.failUpload&&name==='release.json')throw Error('Simulated upload interruption');
    this.uploaded.set(name,bytes);
    this.draft.assets.push({id:this.assetId++,name,size:bytes.length,digest:'sha256:'+(this.corrupt?'0'.repeat(64):hash(bytes)),browser_download_url:'https://example.test/'+name});
  }
}
test('publishing verifies all draft asset hashes before exposing any version',async()=>{
  const api=new FakeGitHub();await publishDraft(api,plan,artifacts());
  assert.equal(api.published,1);assert.equal(api.draft?.draft,false);assert.equal(api.uploaded.size,4);
  const corrupt=new FakeGitHub();corrupt.corrupt=true;
  await assert.rejects(publishDraft(corrupt,plan,artifacts()),/Uploaded artifact mismatch/);
  assert.equal(corrupt.published,0);assert.equal(corrupt.draft?.draft,true);
  corrupt.corrupt=false;await publishDraft(corrupt,plan,artifacts(),structuredClone(corrupt.draft));
  assert.equal(corrupt.published,1);assert.equal(corrupt.draft?.assets.length,4);
});
test('interrupted uploads resume the same draft without exposing partial assets or mutating a publication',async()=>{
  const api=new FakeGitHub();api.failUpload=true;
  await assert.rejects(publishDraft(api,plan,artifacts()),/interruption/);
  assert.equal(api.published,0);assert.equal(api.draft?.draft,true);
  api.failUpload=false;await publishDraft(api,plan,artifacts(),structuredClone(api.draft));
  assert.equal(api.published,1);assert.equal(api.draft?.assets.length,4);
  await assert.rejects(publishDraft(api,plan,artifacts(),api.draft),/Refusing/);
});
test('artifact validation rejects corruption, duplicate/traversal filenames and source mismatches',()=>{
  const files=artifacts();verifyArtifactBytes(plan,files);
  assert.throws(()=>checksums(files.get('SHA256SUMS')!.toString().repeat(2),'0.1.1'),/duplicate/);
  assert.throws(()=>checksums('a'.repeat(64)+'  ../secret','0.1.1'),/Invalid/);
  assert.throws(()=>verifyArtifactBytes({...plan,revision:c},files),/receipt/);
  files.set('opencrawl-0.1.1.tgz',Buffer.from('corrupt'));
  assert.throws(()=>verifyArtifactBytes(plan,files),/checksum/);
});
test('the final verifier fetches every artifact anonymously and rejects inaccessible downloads',async()=>{
  const files=artifacts(),urls:string[]=[];
  const download:typeof fetch=async(input,init)=>{
    assert.equal(init?.headers,undefined);urls.push(String(input));
    const bytes=files.get(String(input).split('/').at(-1)!);
    return new Response(bytes?new Uint8Array(bytes):null,{status:bytes?200:404});
  };
  await verifyPublic(plan,repo,download);assert.equal(urls.length,4);
  assert.ok(urls.every(url=>url.startsWith('https://github.com/'+repo+'/releases/download/helm-v0.1.1/')));
  await assert.rejects(verifyPublic(plan,repo,async()=>new Response(null,{status:404})),/Anonymous/);
});

test('weekly stable selection uses the newest fully checked mainline candidate while main advances',async()=>{
  const old={...runs()[1]!,head_sha:a,id:1},latest={...old,head_sha:b,id:2},foreign={...old,head_sha:c,id:3,head_repository:{full_name:'stranger/fork'}};
  assert.equal(await stableCandidate([old,latest,foreign],repo,()=>true,async revision=>revision===a),a);
  assert.equal(await stableCandidate([old,latest],repo,()=>true,async()=>true),b);
  assert.equal(await stableCandidate([old,latest],repo,revision=>revision===a,async()=>true),a);
  await assert.rejects(stableCandidate([old,latest],repo,()=>true,async()=>false),/No mainline candidate/);
  await assert.rejects(stableCandidate([{...old,event:'pull_request'},foreign],repo,()=>true,async()=>true),/No mainline candidate/);
});
