#!/usr/bin/env node
// Package only images that installers can pull anonymously on both architectures.
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {releaseTitle,versionedChart} from './release.mts';
import {publicIndex} from './image-index.mts';
const {values}=parseArgs({options:{revision:{type:'string'},out:{type:'string'},version:{type:'string'},source:{type:'string'}}});
if(!values.revision||!/^[a-f0-9]{40}$/.test(values.revision)||!values.out)throw Error('Use --revision FULL_GIT_SHA --out OUTPUT_DIRECTORY');
const root=values.source?resolve(values.source):dirname(fileURLToPath(import.meta.url)),out=resolve(values.out),tag='sha-'+values.revision;
async function publishedImage(name:string){
  const repository='getopencrawl/'+name;
  const {digest} = await publicIndex(repository, tag);
  return {repository:'ghcr.io/'+repository,tag,digest};
}
const [image,githubConnector]=await Promise.all([publishedImage('opencrawl-core'),publishedImage('source-github')]);
const chart=readFileSync(join(root,'opencrawl/Chart.yaml'),'utf8');
const version=values.version||chart.match(/^version: (\d+\.\d+\.\d+)$/m)?.[1];
if(!version)throw Error('Chart version must be an explicit semantic version');
const packagedChart=versionedChart(chart,version);
mkdirSync(out,{recursive:true});
const scratch=mkdtempSync(join(tmpdir(),'opencrawl-kit-'));
const run=(command:string,args:string[])=>{const r=spawnSync(command,args,{encoding:'utf8'});if(r.status!==0)throw Error(`${command} packaging failed: ${r.stderr}`);return r.stdout;};
try{
  for(const file of ['install.mts','verify.mts','machine-key.mjs','runtime','opencrawl','airbyte-wrapper','examples'])cpSync(join(root,file),join(scratch,file),{recursive:true});
  writeFileSync(join(scratch,'opencrawl/Chart.yaml'),packagedChart);
  const helm=process.env.HELM||'helm';
  run(helm,['package',join(scratch,'opencrawl'),'--destination',out]);
  const metadata=run(helm,['show','chart',join(out,`opencrawl-${version}.tgz`)]);
  const appVersion=metadata.match(/^appVersion: (\S+)$/m)?.[1];
  if(!appVersion)throw Error('Packaged chart is missing the Core appVersion');
  const title=releaseTitle(appVersion,version);
  const receipt={schemaVersion:1,version,appVersion,revision:values.revision,image,githubConnector,checkedAt:new Date().toISOString()};
  const guide=readFileSync(join(root,'README.md'),'utf8').replace(/^# [^\n]+\n+/,'');
  writeFileSync(join(scratch,'README.md'),`# ${title}\n\n${guide}`);
  writeFileSync(join(scratch,'release.json'),JSON.stringify(receipt,null,2)+'\n');
  for(const file of ['bundled.json','external.json','mixed.json']){const p=join(scratch,'examples',file),config=JSON.parse(readFileSync(p,'utf8'));config.image=image;config.githubConnector=githubConnector;writeFileSync(p,JSON.stringify(config,null,2)+'\n');}
  const kit=`opencrawl-selfhost-${version}.tgz`;
  run('tar',['-czf',join(out,kit),'-C',scratch,'.']);
  writeFileSync(join(out,'release.json'),JSON.stringify(receipt,null,2)+'\n');
  const files=[kit,`opencrawl-${version}.tgz`,'release.json'];
  writeFileSync(join(out,'SHA256SUMS'),files.map(f=>createHash('sha256').update(readFileSync(join(out,f))).digest('hex')+'  '+f).join('\n')+'\n');
  console.log(JSON.stringify({status:'packaged',...receipt,files}));
}finally{rmSync(scratch,{recursive:true,force:true});}
