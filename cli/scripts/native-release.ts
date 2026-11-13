import {readFileSync,readdirSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dir,'..'),dist=join(root,'dist'),output=join(root,'native');
const manifest=JSON.parse(readFileSync(join(dist,'cli/package.json'),'utf8'));
const digest=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const platforms=['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'];
function run(args:string[]){const result=Bun.spawnSync(args,{stdout:'pipe',stderr:'pipe'});if(result.exitCode)throw new Error(result.stderr.toString());return result.stdout.toString();}
if(!process.argv.includes('--publish')){
  mkdirSync(output,{recursive:true});const sums:string[]=[];
  for(const platform of platforms.filter(platform=>!process.argv.includes('--current')||platform===process.platform+'-'+process.arch)){
    const directory=join(dist,platform),pkg=JSON.parse(readFileSync(join(directory,'package.json'),'utf8'));
    if(pkg.version!==manifest.version||pkg.opencrawlRevision!==manifest.opencrawlRevision)throw new Error('Mixed native release artifacts');
    const entries:Record<string,Uint8Array>={};
    // Materialize file bytes: Bun 1.3.14 archives file-backed Blobs as empty
    // entries even though in-memory Blobs and byte arrays are supported.
    for(const file of ['package.json','LICENSE','THIRD_PARTY_NOTICES.txt','runtime/opencrawl.js','bin/'+(platform.startsWith('win32-')?'opencrawl.exe':'opencrawl')]){
      const bytes=readFileSync(join(directory,file));if(!bytes.length)throw new Error('Empty native release file: '+file);entries['package/'+file]=bytes;
    }
    const name='opencrawl-'+platform+'.tgz';await Bun.write(join(output,name),new Bun.Archive(entries,{compress:'gzip'}));
    sums.push(digest(join(output,name))+'  '+name);
  }
  for(const name of ['install.sh','install.ps1']){writeFileSync(join(output,name),readFileSync(join(root,name)));sums.push(digest(join(output,name))+'  '+name);}
  writeFileSync(join(output,'SHA256SUMS'),sums.join('\n')+'\n');
  writeFileSync(join(output,'release.json'),JSON.stringify({version:manifest.version,revision:manifest.opencrawlRevision})+'\n');
}else{
  if(!/^[a-f0-9]{40}$/.test(manifest.opencrawlRevision||''))throw new Error('Native publication requires source provenance');
  const repo='getopencrawl/opencrawl-core',tag='cli-v'+manifest.version;
  const checksummed=[...platforms.map(platform=>'opencrawl-'+platform+'.tgz'),'install.sh','install.ps1'];
  const files=[...checksummed,'SHA256SUMS','release.json'].sort();
  if(JSON.stringify(readdirSync(output).sort())!==JSON.stringify(files))throw new Error('Unexpected or missing native release assets');
  const expected=checksummed.map(name=>digest(join(output,name))+'  '+name).join('\n')+'\n';
  if(readFileSync(join(output,'SHA256SUMS'),'utf8')!==expected)throw new Error('Native release checksum manifest differs');
  const receipt=JSON.parse(readFileSync(join(output,'release.json'),'utf8'));
  if(receipt.version!==manifest.version||receipt.revision!==manifest.opencrawlRevision)throw new Error('Native source provenance differs');
  const scratch=mkdtempSync(join(tmpdir(),'opencrawl-native-release-'));
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
    // The update channel must not advertise a native release until anonymous
    // downloads return the exact tested bytes, including through the asset CDN.
    for(const name of files){
      const deadline=Date.now()+120_000;
      for(;;){
        try{
          const response=await fetch('https://github.com/'+repo+'/releases/download/'+tag+'/'+name,{signal:AbortSignal.timeout(60_000)});
          if(!response.ok||!response.body)throw new Error('Native asset HTTP '+response.status);
          const hash=createHash('sha256');for await(const chunk of response.body)hash.update(chunk);
          if(hash.digest('hex')!==digest(join(output,name)))throw new Error('Published native asset differs: '+name);
          break;
        }catch(error){if(String(error).includes('Published native asset differs:')||Date.now()>=deadline)throw error;await Bun.sleep(5000);}
      }
    }
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
