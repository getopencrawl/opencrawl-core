import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';

export const LEGACY_ONLINE_PACKAGE=Object.freeze({
 name:'@getopencrawl/opencrawl-core',version:'0.4.1-cd.428.gbcfe0643abdf',revision:'bcfe0643abdf16a06734dd844576cb0cdb04f9cf',
 integrity:'sha512-M7n0XlSO892Soee7v5sZsxebdkZLEQAKyaExty+vk8z5UV2fvL8baYDvg9hVzTQgn1Qd9gREApOo5hoIrX9UmA==',
});
export const LEGACY_ONLINE_MODULES=['dist/src/sessions/s3-store.mjs','dist/src/sessions/types.mjs'] as const;
const sha256=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
export function verifyLegacyArchiveIntegrity(bytes:Buffer){
 assert.ok(bytes.length>0&&bytes.length<=128*1024*1024,'Published archive byte bound exceeded');
 assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),LEGACY_ONLINE_PACKAGE.integrity,'Exact published package integrity differs');
}
export function verifyLegacyPackageMetadata(manifest:unknown,source:unknown){
 assert.ok(manifest&&typeof manifest==='object'&&'name'in manifest&&'version'in manifest&&'exports'in manifest);
 assert.equal(manifest.name,LEGACY_ONLINE_PACKAGE.name);assert.equal(manifest.version,LEGACY_ONLINE_PACKAGE.version);
 const exports=manifest.exports;assert.ok(exports&&typeof exports==='object'&&'./sessions/s3-store'in exports);
 assert.equal(exports['./sessions/s3-store'],'./dist/src/sessions/s3-store.mjs','Published adapter export differs');
 assert.ok(source&&typeof source==='object'&&'revision'in source);assert.equal(source.revision,LEGACY_ONLINE_PACKAGE.revision,'Published embedded revision differs');
}
export function verifyLegacyArchiveMember(path:string,details:string){
 assert.ok(['package/package.json','package/revision.json',...LEGACY_ONLINE_MODULES.map(value=>'package/'+value)].includes(path),'Unexpected archive member');
 const lines=details.trim().split('\n');
 assert.equal(lines.length,1,'Duplicate or missing archive member');
 assert.ok(lines[0]?.startsWith('-')&&lines[0].endsWith(' '+path),'Selected archive member is not one regular file');
}
function readEntry(archive:string,path:string){
 assert.ok(['package/package.json','package/revision.json',...LEGACY_ONLINE_MODULES.map(value=>'package/'+value)].includes(path),'Unexpected archive member');
 // Never extract archive paths to disk. Only fixed regular members are read to
 // stdout after whole-tar integrity verification; symlinks/duplicates fail.
 const details=execFileSync('tar',['-tvzf',archive,path],{encoding:'utf8',maxBuffer:65536,timeout:30000,env:{...process.env,LC_ALL:'C'}});
 verifyLegacyArchiveMember(path,details);
 return execFileSync('tar',['-xOf',archive,path],{maxBuffer:4*1024*1024,timeout:30000});
}
export function preparePublishedOnlineCompatibility(output:string){
 const directory=resolve(output);mkdirSync(directory,{mode:0o700});let packed:unknown;
 try{packed=JSON.parse(execFileSync('npm',['pack',LEGACY_ONLINE_PACKAGE.name+'@'+LEGACY_ONLINE_PACKAGE.version,'--registry=https://npm.pkg.github.com','--ignore-scripts','--json','--pack-destination',directory],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:180000,stdio:['ignore','pipe','pipe']}));}
 catch{throw new Error('Exact published compatibility package fetch failed; no alternate credential or source fallback');}
 assert.ok(Array.isArray(packed)&&packed.length===1&&typeof packed[0]?.filename==='string');const filename=packed[0].filename as string;
 assert.equal(filename,basename(filename));assert.match(filename,/^[A-Za-z0-9_.-]+\.tgz$/);
 const downloaded=join(directory,filename),stat=lstatSync(downloaded);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=128*1024*1024);
 const archiveBytes=readFileSync(downloaded);verifyLegacyArchiveIntegrity(archiveBytes);
 verifyLegacyPackageMetadata(JSON.parse(readEntry(downloaded,'package/package.json').toString()),JSON.parse(readEntry(downloaded,'package/revision.json').toString()));
 const archive=join(directory,'legacy-core-428.tgz');renameSync(downloaded,archive);
 const modules=LEGACY_ONLINE_MODULES.map(path=>{const bytes=readEntry(archive,'package/'+path),target=join(directory,'legacy',path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes,{flag:'wx',mode:0o600});return {path,bytes:bytes.length,sha256:sha256(bytes)};});
 const currentRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',maxBuffer:4096}).trim();assert.match(currentRevision,/^[a-f0-9]{40}$/);
 const receipt={format:1,kind:'verified-published-online-compatibility-input',legacy:LEGACY_ONLINE_PACKAGE,archive:{filename:'legacy-core-428.tgz',bytes:archiveBytes.length,sha256:sha256(archiveBytes)},modules,currentRevision};
 writeFileSync(join(directory,'verified.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 // No npm output, environment, credentials or .npmrc is retained or emitted.
 return {state:'verified-published-adapter',version:LEGACY_ONLINE_PACKAGE.version,revision:LEGACY_ONLINE_PACKAGE.revision,archiveSha256:receipt.archive.sha256};
}
if(import.meta.main){assert.equal(process.argv.length,3,'Expected one fresh output directory');console.log(JSON.stringify(preparePublishedOnlineCompatibility(process.argv[2]!)));}
