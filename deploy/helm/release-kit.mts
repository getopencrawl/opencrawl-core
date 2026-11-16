#!/usr/bin/env node
// Package only images that installers can pull anonymously on both architectures.
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{revision:{type:'string'},out:{type:'string'}}});
if(!values.revision||!/^[a-f0-9]{40}$/.test(values.revision)||!values.out)throw Error('Use --revision FULL_GIT_SHA --out OUTPUT_DIRECTORY');
const root=dirname(fileURLToPath(import.meta.url)),out=resolve(values.out),tag='sha-'+values.revision;
async function publishedImage(name:string){
  const repository='getopencrawl/'+name;
  const auth=await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository:'+repository+':pull',{signal:AbortSignal.timeout(30000)});
  if(!auth.ok)throw Error(`Image ${repository} is not anonymously pullable (HTTP ${auth.status})`);
  const {token}=await auth.json();
  const r=await fetch('https://ghcr.io/v2/'+repository+'/manifests/'+tag,{headers:{authorization:'Bearer '+token,accept:'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'},signal:AbortSignal.timeout(30000)});
  if(!r.ok)throw Error(`Published image ${repository}:${tag} is unavailable (HTTP ${r.status})`);
  const bytes=Buffer.from(await r.arrayBuffer()),digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
  if(r.headers.get('docker-content-digest')!==digest)throw Error('Registry manifest digest mismatch');
  const platforms=JSON.parse(bytes.toString()).manifests?.map((x:{platform?:{os:string;architecture:string}})=>x.platform?.os+'/'+x.platform?.architecture)||[];
  for(const p of ['linux/amd64','linux/arm64'])if(!platforms.includes(p))throw Error(`${repository} lacks ${p}`);
  return {repository:'ghcr.io/'+repository,tag,digest};
}
const [image,githubConnector]=await Promise.all([publishedImage('opencrawl-core'),publishedImage('source-github')]);
const version=readFileSync(join(root,'opencrawl/Chart.yaml'),'utf8').match(/^version: (\d+\.\d+\.\d+)$/m)?.[1];
if(!version)throw Error('Chart version must be an explicit semantic version');
const receipt={schemaVersion:1,version,revision:values.revision,image,githubConnector,checkedAt:new Date().toISOString()};
mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(tmpdir(),'opencrawl-kit-'));
const run=(command:string,args:string[])=>{const r=spawnSync(command,args,{encoding:'utf8'});if(r.status!==0)throw Error(`${command} packaging failed: ${r.stderr}`);};
try{
  for(const file of ['install.mts','verify.mts','runtime','opencrawl','airbyte-wrapper','examples','README.md'])cpSync(join(root,file),join(scratch,file),{recursive:true});
  writeFileSync(join(scratch,'release.json'),JSON.stringify(receipt,null,2)+'\n');
  for(const file of ['bundled.json','external.json','mixed.json']){const p=join(scratch,'examples',file),config=JSON.parse(readFileSync(p,'utf8'));config.image=image;config.githubConnector=githubConnector;writeFileSync(p,JSON.stringify(config,null,2)+'\n');}
  run(process.env.HELM||'helm',['package',join(scratch,'opencrawl'),'--destination',out]);
  const kit=`opencrawl-selfhost-${version}.tgz`;
  run('tar',['-czf',join(out,kit),'-C',scratch,'.']);
  writeFileSync(join(out,'release.json'),JSON.stringify(receipt,null,2)+'\n');
  const files=[kit,`opencrawl-${version}.tgz`,'release.json'];
  writeFileSync(join(out,'SHA256SUMS'),files.map(f=>createHash('sha256').update(readFileSync(join(out,f))).digest('hex')+'  '+f).join('\n')+'\n');
  console.log(JSON.stringify({status:'packaged',...receipt,files}));
}finally{rmSync(scratch,{recursive:true,force:true});}
