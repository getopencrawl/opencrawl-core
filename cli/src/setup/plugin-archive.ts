import {fromBufferPromise} from 'yauzl';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {CliError} from '../oauth.ts';
import {atomicFile} from '../session.ts';
import {fileHash,MAX_PLUGIN_BINARY,MAX_PLUGIN_TEXT} from './plugin-bundle.ts';
import type {PackageRelease,ArchivePin,PluginRelease} from './plugin-release.ts';

const invalid=()=>new CliError('PLUGIN_PACKAGE_INVALID','The pinned plugin archive could not be verified. Existing plugins were preserved.');
const manifests:Partial<Record<PackageRelease['harness'],string>>={'claude-code':'.claude-plugin/plugin.json',codex:'.codex-plugin/plugin.json',cursor:'.cursor-plugin/plugin.json',antigravity:'.antigravity-plugin/plugin.json'};
const privateSkills=['oc-incognito','oc-private','opencrawl-private','oc-readonly'].map(name=>'skills/'+name+'/SKILL.md');
const baseFiles=['.mcp.json','mcp.json','LICENSE','README.md','capabilities.json','skills/opencrawl/SKILL.md'];
const runtimeFiles=['auth.mjs','capture.mjs','io.mjs','lifecycle.mjs','main.mjs','redact.mjs','THIRD_PARTY_NOTICES.txt'].map(name=>'runtime/'+name);
const maxArchive=160*1024*1024;
const validName=(name:string)=>/^[a-zA-Z0-9._/-]+$/.test(name)&&!name.split('/').some(part=>!part||part==='.'||part==='..');
export function validateArtifact(value:unknown,entry:PackageRelease,platform:string,pin:ArchivePin){
 const data=value as {schemaVersion?:unknown;harness?:unknown;name?:unknown;version?:unknown;platform?:unknown;filename?:unknown;sha256?:unknown;executable?:unknown;source?:unknown};
 const executable=platform.startsWith('win32-')?'bin/opencrawl-hook.exe':'bin/opencrawl-hook';
 const manifest=manifests[entry.harness];
 const incognito=Array.isArray(data?.source)&&data.source.includes('runtime/privacy.mjs');
 const sourceFiles=[...runtimeFiles,...(incognito?['runtime/privacy.mjs']:[]),...(Array.isArray(data?.source)&&data.source.includes('runtime/board.mjs')?['runtime/board.mjs']:[])];
 if(!data||!manifest||!['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'].includes(platform)||
  data.schemaVersion!==1||data.harness!==entry.harness||data.name!==entry.name||data.version!==entry.version||data.platform!==platform||
  data.filename!==`${entry.name==='opencrawl'?'opencrawl-'+entry.harness:entry.name}-${entry.version}-${platform}.zip`||data.sha256!==pin.sha256||data.executable!==executable||
  !Array.isArray(data.source)||JSON.stringify([...data.source].sort())!==JSON.stringify([...sourceFiles].sort()))throw invalid();
 const nativeFiles=entry.harness==='antigravity'?['hooks.json','mcp_config.json']:['hooks/hooks.json'];
 return {executable,manifest,allowed:new Set([manifest,...baseFiles,...(entry.listingIcon?['assets/icon.svg']:[]),...(entry.memoryImportSkill?['skills/oc-import-memories/SKILL.md']:[]),...(entry.continueSkill?['skills/oc-continue/SKILL.md']:[]),...nativeFiles,...sourceFiles,...(incognito?privateSkills:[]),...(incognito&&entry.harness==='codex'?privateSkills.map(path=>path.replace('SKILL.md','agents/openai.yaml')):[]),executable])};
}

/** Read regular allowlisted files into memory; never extract paths or run ZIP content. */
export async function readPluginArchive(archive:Buffer,metadata:Buffer,entry:PackageRelease,platform:string,pin:ArchivePin,historical=false){
 if(archive.length>maxArchive||metadata.length>16_384||fileHash(archive)!==pin.sha256||fileHash(metadata)!==pin.metadataSha256)throw invalid();
 try{
  const {executable,manifest:manifestFile,allowed}=validateArtifact(JSON.parse(metadata.toString('utf8')),entry,platform,pin);
  // Older installation receipts pin both immutable digests but predate the
  // three optional presentation/skill flags. Keep every runtime file mandatory.
  const optional=historical?new Set(['assets/icon.svg','skills/oc-import-memories/SKILL.md','skills/oc-continue/SKILL.md']):new Set<string>();
  for(const name of optional)allowed.add(name);
  const zip=await fromBufferPromise(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true});
  try{
   if(zip.entryCount>allowed.size||zip.entryCount<allowed.size-optional.size)throw invalid();
   const files:Record<string,string>={},binaries:Record<string,Buffer>={},seen=new Set<string>();let textSize=0;
   for await(const entry of zip.eachEntry()){
    const name=entry.fileName,mode=entry.externalFileAttributes>>>16,limit=name===executable?MAX_PLUGIN_BINARY:MAX_PLUGIN_TEXT;
    if(!validName(name)||!allowed.has(name)||seen.has(name)||entry.isEncrypted()||![0,8].includes(entry.compressionMethod)||
     (entry.versionMadeBy>>>8)!==3||(mode&0o170000)!==0o100000||(mode&0o7777)!==(name===executable?0o755:0o644)||
     !Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<=0||entry.uncompressedSize>limit)throw invalid();
    seen.add(name);if(name!==executable&&(textSize+=entry.uncompressedSize)>MAX_PLUGIN_TEXT)throw invalid();
    const stream=await zip.openReadStreamPromise(entry),chunks:Buffer[]=[];let size=0;
    try{for await(const chunk of stream){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit)throw invalid();chunks.push(bytes);}}finally{stream.destroy();}
    if(size!==entry.uncompressedSize)throw invalid();
    const bytes=Buffer.concat(chunks);
    if(name===executable)binaries[name]=bytes;else files[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   }
   if([...allowed].some(name=>!optional.has(name)&&!seen.has(name)))throw invalid();
   const manifest=JSON.parse(files[manifestFile]!);
   if(manifest.name!==entry.name||manifest.version!==entry.version)throw invalid();
   return {files,binaries,executable};
  }finally{zip.close();}
 }catch(error){if(error instanceof CliError)throw error;throw invalid();}
}

function allowedUrl(value:string,release:PluginRelease,redirect=false){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.hash)throw invalid();
 const official=url.hostname==='github.com'&&url.pathname.startsWith('/'+release.repository+'/releases/download/')||
  url.hostname==='raw.githubusercontent.com'&&url.pathname.startsWith('/'+release.repository+'/'+release.ref+'/');
 if(!official&&!(redirect&&url.hostname==='release-assets.githubusercontent.com'))throw invalid();
 return url;
}
async function download(url:string,limit:number,release:PluginRelease,fetcher:typeof fetch,cancel?:AbortSignal){
 let target=allowedUrl(url,release);const timeout=AbortSignal.timeout(90_000),signal=cancel?AbortSignal.any([cancel,timeout]):timeout;
 for(let redirects=0;redirects<=3;redirects++){
  const response=await fetcher(target,{redirect:'manual',signal});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');await response.body?.cancel();if(!location)throw invalid();target=allowedUrl(new URL(location,target).href,release,true);continue;
  }
  if(!response.ok||!response.body||Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw invalid();}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw invalid();chunks.push(value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks);
 }
 throw invalid();
}
export async function loadPluginArchive(entry:PackageRelease,release:PluginRelease,platform:string,{fetcher,cache,signal,historical=false}:{fetcher:typeof fetch;cache:string;signal?:AbortSignal;historical?:boolean}){
 if(!['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64'].includes(platform))throw new CliError('PLUGIN_PLATFORM_UNAVAILABLE','This pinned plugin has no package for this machine. Existing plugins were preserved.',2);
 const pin=entry.archives?.[platform];
 if(!pin)throw new CliError('PLUGIN_PLATFORM_UNAVAILABLE','This pinned plugin has no package for this machine. Existing plugins were preserved.',2);
 if(!/^[a-f0-9]{64}$/.test(pin.sha256)||!/^[a-f0-9]{64}$/.test(pin.metadataSha256))throw invalid();
 allowedUrl(pin.url,release);allowedUrl(pin.metadataUrl,release);
 const directory=join(cache,release.ref,entry.harness,platform),zipPath=join(directory,pin.sha256+'.zip'),metadataPath=join(directory,pin.metadataSha256+'.json');
 const read=(path:string,sha:string,limit:number)=>{try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)return;const bytes=readFileSync(path);return bytes.length<=limit&&fileHash(bytes)===sha?bytes:undefined;}catch{return;}};
 let metadata=read(metadataPath,pin.metadataSha256,16_384),archive=read(zipPath,pin.sha256,maxArchive);
 const cached=Boolean(metadata&&archive);
 metadata??=await download(pin.metadataUrl,16_384,release,fetcher,signal);
 if(fileHash(metadata)!==pin.metadataSha256)throw invalid();
 try{validateArtifact(JSON.parse(metadata.toString('utf8')),entry,platform,pin);}catch{throw invalid();}
 archive??=await download(pin.url,maxArchive,release,fetcher,signal);
 const result=await readPluginArchive(archive,metadata,entry,platform,pin,historical);
 if(!cached){atomicFile(zipPath,archive);atomicFile(metadataPath,metadata);}
 return {...result,archive:{platform,url:pin.url,sha256:pin.sha256,metadataSha256:pin.metadataSha256}};
}
