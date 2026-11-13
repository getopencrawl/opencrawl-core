import {readFileSync,readdirSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dir,'..'),dist=join(root,'dist'),output=join(root,'native');
const manifest=JSON.parse(readFileSync(join(dist,'cli/package.json'),'utf8'));
const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
function run(args:string[]){const result=Bun.spawnSync(args,{stdout:'pipe',stderr:'pipe'});if(result.exitCode)throw new Error(result.stderr.toString());return result.stdout.toString();}
if(!process.argv.includes('--publish')){
  mkdirSync(output,{recursive:true});const sums:string[]=[];
  for(const platform of readdirSync(dist).filter(name=>name!=='cli').sort()){
    const directory=join(dist,platform),pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    if(pkg.version!==manifest.version||pkg.opencrawlRevision!==manifest.opencrawlRevision)throw new Error('Mixed native release artifacts');
    const entries:Record<string,Blob>={};
    for(const file of ['package.json','LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js','bin/'+(platform.startsWith('win32-')?'opencrawl.exe':'opencrawl')])entries['package/'+file]=Bun.file(join(directory,file));
    const name='opencrawl-'+platform+'.tgz';await Bun.write(join(output,name),new Bun.Archive(entries,{compress:'gzip'}));
    sums.push(digest(join(output,name))+'  '+name);
  }
  for(const name of ['install.sh','install.ps1']){writeFileSync(join(output,name),readFileSync(join(root,name)));sums.push(digest(join(output,name))+'  '+name);}
  writeFileSync(join(output,'SHA256SUMS'),sums.join('\n')+'\n');
  writeFileSync(join(output,'release.json'),JSON.stringify({version:manifest.version,revision:manifest.opencrawlRevision})+'\n');
}else{
  if(!/^[a-f0-9]{40}$/.test(manifest.opencrawlRevision||''))throw new Error('Native publication requires source provenance');
  const repo='getopencrawl/opencrawl-core',tag='cli-v'+manifest.version;
  const files=readdirSync(output).sort(),scratch=mkdtempSync(join(tmpdir(),'opencrawl-native-release-'));
  try{
    const probe=Bun.spawnSync(['gh','release','view',tag,'--repo',repo,'--json','tagName'],{stdout:'pipe',stderr:'pipe'});
    if(probe.exitCode){
      if(!probe.stderr.toString().includes('release not found'))throw new Error(probe.stderr.toString());
      const notes=join(scratch,'notes.md');writeFileSync(notes,'OpenCrawl CLI '+manifest.version+'\n\nNative executables built and tested from '+manifest.opencrawlRevision+'. Archives include the replaceable runtime bundle and license notices. Verify downloads against SHA256SUMS.\n');
      run(['gh','release','create',tag,'--repo',repo,'--target',manifest.opencrawlRevision,'--title','OpenCrawl CLI '+manifest.version,'--notes-file',notes,'--latest=false','--draft']);
    }
    const assets=JSON.parse(run(['gh','release','view',tag,'--repo',repo,'--json','assets'])).assets as {name:string}[];
    for(const name of files){
      if(assets.some(asset=>asset.name===name)){
        run(['gh','release','download',tag,'--repo',repo,'--pattern',name,'--dir',scratch]);
        if(digest(join(scratch,name))!==digest(join(output,name)))throw new Error('Existing immutable native asset differs: '+name);
      }else run(['gh','release','upload',tag,join(output,name),'--repo',repo]);
    }
    run(['gh','release','edit',tag,'--repo',repo,'--draft=false','--latest=false']);
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
