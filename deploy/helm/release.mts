import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const sha=/^[a-f0-9]{40}$/;
const semver=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function versionParts(version:string):bigint[]{
  if(!semver.test(version))throw Error('Expected a stable Helm version: MAJOR.MINOR.PATCH');
  return version.split('.').map(BigInt);
}
export function versionedChart(chart:string,version:string):string{
  versionParts(version);
  if([...chart.matchAll(/^version: \d+\.\d+\.\d+$/gm)].length!==1)throw Error('Expected one chart version');
  return chart.replace(/^version: \d+\.\d+\.\d+$/m,'version: '+version);
}
export interface Run {id:number;path:string;event:string;head_branch:string;head_sha:string;head_repository?:{full_name:string};status:string;conclusion:string|null}
export const gates=['ci.yml','self-host.yml','selfhost-images.yml','security.yml','plugins.yml'];
export function checksPassed(runs:Run[],revision:string,repository:string):boolean{
  const trusted=runs.filter(r=>r.event==='push'&&r.head_branch==='main'&&r.head_sha===revision&&r.head_repository?.full_name===repository);
  const required=[...gates,...['cli.yml','helm.yml'].filter(file=>trusted.some(r=>r.path==='.github/workflows/'+file))];
  return required.every(file=>{
    const latest=trusted.filter(r=>r.path==='.github/workflows/'+file).sort((a,b)=>b.id-a.id)[0];
    return latest?.status==='completed'&&latest.conclusion==='success';
  });
}
/** Fast main may still be validating at the weekly release tick. Select a
 * completed mainline candidate rather than depending on an idle branch head. */
export async function stableCandidate(runs:Run[],repository:string,isMainline:(revision:string)=>boolean,passed:(revision:string)=>Promise<boolean>):Promise<string>{
  const candidates=runs.filter(r=>r.path==='.github/workflows/self-host.yml'&&r.event==='push'&&r.head_branch==='main'&&r.head_repository?.full_name===repository&&r.status==='completed'&&r.conclusion==='success'&&sha.test(r.head_sha)).sort((a,b)=>b.id-a.id);
  for(const run of candidates)if(isMainline(run.head_sha)&&await passed(run.head_sha))return run.head_sha;
  throw Error('No mainline candidate has passed every stable distribution gate');
}
export interface Asset {id:number;name:string;size:number;digest:string|null;browser_download_url:string}
export interface Release {id:number;tag_name:string;target_commitish:string;draft:boolean;prerelease:boolean;body?:string;assets:Asset[]}
export interface Plan {action:'publish'|'verify'|'skip';revision:string;version?:string;reason?:string}
function compare(a:string,b:string):number{
  const av=versionParts(a),bv=versionParts(b);
  for(let i=0;i<3;i++)if(av[i]!==bv[i])return av[i]!>bv[i]!?1:-1;
  return 0;
}
const marker=(version:string,revision:string)=>`<!-- opencrawl-helm ${version} ${revision} -->`;
export function selectRelease(releases:Release[],revision:string,requested:string|undefined,isAncestor:(a:string,b:string)=>boolean):Plan{
  if(!sha.test(revision))throw Error('Expected a full immutable source SHA');
  if(requested)versionParts(requested);
  const helm=releases.filter(r=>r.tag_name.startsWith('helm-v')&&semver.test(r.tag_name.slice(6)));
  const stable=helm.filter(r=>!r.draft&&!r.prerelease).sort((a,b)=>compare(b.tag_name.slice(6),a.tag_name.slice(6)));
  const latest=stable[0];
  if(!latest||!sha.test(latest.target_commitish))throw Error('A published Helm baseline with an immutable source SHA is required');
  const base=latest.tag_name.slice(6),[major,minor,patch]=versionParts(base);
  if(requested){
    const existing=stable.find(r=>r.tag_name==='helm-v'+requested);
    if(existing){
      if(existing.target_commitish!==revision)throw Error('That published Helm version belongs to another source revision');
      return {action:'verify',revision,version:requested};
    }
  }else{
    if(latest.target_commitish===revision)return {action:'verify',revision,version:base};
    if(isAncestor(revision,latest.target_commitish))return {action:'skip',revision,reason:'A newer source revision is already released'};
  }
  if(!isAncestor(latest.target_commitish,revision))throw Error('Release source must descend from the latest published Helm source');
  const version=requested||`${major}.${minor}.${patch!+1n}`;
  if(requested&&requested!==`${major}.${minor!+1n}.0`&&requested!==`${major!+1n}.0.0`)throw Error('Manual releases must be the next minor or major version; patches are automatic');
  const occupied=helm.find(r=>r.tag_name==='helm-v'+version);
  if(occupied&&(!occupied.draft||occupied.prerelease||occupied.target_commitish!==revision||!occupied.body?.includes(marker(version,revision))))throw Error('The next version is reserved by another release; do not overwrite it');
  if(helm.some(r=>r.draft&&r!==occupied))throw Error('An unfinished Helm draft exists; rerun its original workflow before another release');
  return {action:'publish',revision,version};
}

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export function artifactNames(version:string):string[]{versionParts(version);return [`opencrawl-${version}.tgz`,`opencrawl-selfhost-${version}.tgz`,'release.json','SHA256SUMS'];}
export function checksums(text:string,version:string):Map<string,string>{
  const entries=new Map<string,string>();
  for(const line of text.trim().split('\n')){
    const match=/^([a-f0-9]{64})  ([^\s/]+)$/.exec(line);
    if(!match||entries.has(match[2]!))throw Error('Invalid or duplicate release checksum');
    entries.set(match[2]!,match[1]!);
  }
  const names=artifactNames(version).filter(n=>n!=='SHA256SUMS');
  if(entries.size!==names.length||names.some(n=>!entries.has(n)))throw Error('Incomplete or unexpected Helm release artifacts');
  return entries;
}
export function verifyArtifactBytes(plan:Plan,files:Map<string,Buffer>):void{
  if(!plan.version)throw Error('Missing planned version');
  for(const [name,hash] of checksums(files.get('SHA256SUMS')!.toString(),plan.version))if(digest(files.get(name)!)!==hash)throw Error('Artifact checksum mismatch: '+name);
  const receipt=JSON.parse(files.get('release.json')!.toString());
  if(receipt.revision!==plan.revision||receipt.version!==plan.version)throw Error('Release receipt does not match its planned source/version');
}
export interface GitHub {
  request<T>(path:string,method?:string,body?:unknown):Promise<T>;
  upload(release:number,name:string,bytes:Buffer):Promise<void>;
}
function client(repository:string):GitHub{
  const headers={authorization:'Bearer '+process.env.GH_TOKEN,accept:'application/vnd.github+json'};
  return {
    async request<T>(path:string,method='GET',body?:unknown):Promise<T>{
      const r=await fetch(`https://api.github.com/repos/${repository}/${path}`,{method,headers:{...headers,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
      if(!r.ok)throw Error(`GitHub ${method} ${path}: HTTP ${r.status}`);
      return (r.status===204?undefined:await r.json()) as T;
    },
    async upload(id,name,bytes){
      const r=await fetch(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(name)}`,{method:'POST',headers:{...headers,'content-type':'application/octet-stream'},body:new Uint8Array(bytes),signal:AbortSignal.timeout(60000)});
      if(!r.ok)throw Error(`GitHub upload ${name}: HTTP ${r.status}`);
    },
  };
}
async function inventory(api:GitHub):Promise<Release[]>{
  const all:Release[]=[];
  for(let page=1;;page++){
    const releases=await api.request<Release[]>(`releases?per_page=100&page=${page}`);
    all.push(...releases);if(releases.length<100)return all;
  }
}
async function ready(api:GitHub,revision:string,repository:string):Promise<boolean>{
  const runs=await api.request<{total_count:number;workflow_runs:Run[]}>(`actions/runs?head_sha=${revision}&event=push&branch=main&per_page=100`);
  if(runs.total_count>100)throw Error('Incomplete workflow-run inventory');
  return checksPassed(runs.workflow_runs,revision,repository);
}
function ancestor(a:string,b:string):boolean{
  const r=spawnSync('git',['merge-base','--is-ancestor',a,b],{encoding:'utf8'});
  if(r.status!==0&&r.status!==1)throw Error('Could not verify source ancestry: '+r.stderr);
  return r.status===0;
}
export async function verifyPublic(plan:Plan,repository:string,download:typeof fetch=fetch):Promise<void>{
  const files=new Map<string,Buffer>();
  for(const name of artifactNames(plan.version!)){
    const r=await download(`https://github.com/${repository}/releases/download/helm-v${plan.version}/${name}`,{signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw Error(`Anonymous release download ${name}: HTTP ${r.status}`);
    files.set(name,Buffer.from(await r.arrayBuffer()));
  }
  verifyArtifactBytes(plan,files);
}
export async function publishDraft(api:GitHub,plan:Plan,files:Map<string,Buffer>,existing?:Release):Promise<void>{
  verifyArtifactBytes(plan,files);
  const version=plan.version!,tag='helm-v'+version;
  let draft=existing;
  if(draft&&(!draft.draft||draft.prerelease||draft.tag_name!==tag||draft.target_commitish!==plan.revision||!draft.body?.includes(marker(version,plan.revision))))throw Error('Refusing to mutate an existing release with a different identity');
  if(!draft)draft=await api.request<Release>('releases','POST',{
    tag_name:tag,target_commitish:plan.revision,name:'OpenCrawl Helm '+version,draft:true,prerelease:false,make_latest:'false',
    body:`${marker(version,plan.revision)}\n\nOpenCrawl Helm ${version}, from tested source \`${plan.revision}\`.\n\nDownload the self-host kit and SHA256SUMS, verify the archive checksum, and follow its README. Public amd64/arm64 images are recorded in release.json; no application build is required.\n\nThe bundled, mixed and external configurations remain available. Existing installations upgrade explicitly. This release does not deploy OpenCrawl Cloud.`,
  });
  const names=artifactNames(version);
  if(draft.assets.some(a=>!names.includes(a.name)))throw Error('Unexpected assets in the reserved draft');
  for(const name of names){
    const bytes=files.get(name)!,old=draft.assets.find(a=>a.name===name);
    if(old?.digest==='sha256:'+digest(bytes)&&old.size===bytes.length)continue;
    if(old)await api.request(`releases/assets/${old.id}`,'DELETE');
    await api.upload(draft.id,name,bytes);
  }
  const uploaded=await api.request<Release>(`releases/${draft.id}`);
  if(!uploaded.draft||uploaded.prerelease||uploaded.tag_name!==tag||uploaded.target_commitish!==plan.revision||!uploaded.body?.includes(marker(version,plan.revision))||uploaded.assets.length!==names.length)throw Error('Draft changed during publication');
  for(const name of names){const a=uploaded.assets.find(a=>a.name===name),bytes=files.get(name)!;if(a?.digest!=='sha256:'+digest(bytes)||a.size!==bytes.length)throw Error('Uploaded artifact mismatch: '+name);}
  await api.request(`releases/${draft.id}`,'PATCH',{draft:false,make_latest:'false'});
}

if(import.meta.main){
  const repository=process.env.GITHUB_REPOSITORY!;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository)||!process.env.GH_TOKEN)throw Error('GitHub release context is required');
  const api=client(repository),mode=process.argv[2];
  const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!,'utf8'));
  const manual=process.env.GITHUB_EVENT_NAME==='workflow_dispatch';
  if(process.env.GITHUB_REF!=='refs/heads/main'||!['workflow_dispatch','schedule'].includes(process.env.GITHUB_EVENT_NAME!))throw Error('Only scheduled or manual mainline events may publish stable Helm releases');
  const candidates=manual?undefined:await api.request<{workflow_runs:Run[]}>('actions/workflows/self-host.yml/runs?event=push&branch=main&status=success&per_page=100');
  const revision=manual?event.inputs?.revision:await stableCandidate(candidates!.workflow_runs,repository,r=>ancestor(r,'origin/main'),r=>ready(api,r,repository));
  const requested=manual?event.inputs?.version:undefined;
  if(!sha.test(revision||'')||manual&&!requested)throw Error('A full source SHA and an explicit manual version are required');
  if(!ancestor(revision,'origin/main'))throw Error('Release source is not on main');
  const releases=await inventory(api);
  const plan=selectRelease(releases,revision,requested,ancestor);
  if(plan.action==='publish'&&!await ready(api,revision,repository)){
    throw Error('The exact source revision has not passed every stable release gate; retry after validation');
  }
  if(mode==='plan'){
    writeFileSync('helm-release-plan.json',JSON.stringify(plan,null,2)+'\n');
    for(const [key,value] of Object.entries(plan))if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`);
    console.log(JSON.stringify(plan));
  }else if(mode==='publish'){
    const planned:Plan=JSON.parse(readFileSync('helm-release-plan.json','utf8'));
    if(plan.action!==planned.action||plan.version!==planned.version||plan.revision!==planned.revision)throw Error('Release state changed; rerun instead of publishing a stale plan');
    if(plan.action==='publish'){
      const refs=await api.request<{ref:string;object:{sha:string;type:string}}[]>('git/matching-refs/tags/helm-v'+plan.version);
      const ref=refs.find(r=>r.ref==='refs/tags/helm-v'+plan.version);
      if(ref&&(ref.object.type!=='commit'||ref.object.sha!==revision))throw Error('Release tag is already bound to another source');
      const files=new Map(artifactNames(plan.version!).map(name=>[name,readFileSync(join('artifacts',name))]));
      await publishDraft(api,plan,files,releases.find(r=>r.tag_name==='helm-v'+plan.version));
    }
    if(plan.action!=='skip'){
      await verifyPublic(plan,repository);
      const ref=await api.request<{object:{sha:string}}>('git/ref/tags/helm-v'+plan.version);
      if(ref.object.sha!==revision)throw Error('Published tag does not match the tested source');
      console.log(`Verified public Helm ${plan.version} from ${revision}`);
    }
  }else throw Error('Use release.mts plan or publish');
}
