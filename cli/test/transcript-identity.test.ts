import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,renameSync,openSync,closeSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {transcriptIdentity} from '../src/capture/transcript-checkpoint.ts';
import {assertSameFile} from '../scripts/file-identity.ts';

test('Bun bigint descriptor identities match native Node identity for distinct files',()=>{
 const node=Bun.which('node');if(!node)throw Error('Node is required only for this independent identity test');
 const root=mkdtempSync(join(tmpdir(),'opencrawl-native-identity-')),file=join(root,'transcript.jsonl');
 const identity=(path:string)=>{const fd=openSync(path,'r');try{return transcriptIdentity(fd);}finally{closeSync(fd);}};
 try{
  writeFileSync(file,'same bytes');const original=identity(file);renameSync(file,file+'.retained');writeFileSync(file,'same bytes');
  const replacement=identity(file);expect(replacement).not.toBe(original);
  for(const path of [file,file+'.retained']){const reference=assertSameFile(node,path,path);expect(identity(path)).toBe(reference.dev+':'+reference.ino);}
 }finally{rmSync(root,{recursive:true,force:true});}
});

for(const harness of ['claude-code','codex','antigravity','cursor'])for(const mode of ['exact','legacy','legacy-safe','malformed'])
test(`${harness} ${mode} identity excludes a replaced private tail when numeric IDs collide`,async()=>{
 const child=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/transcript-identity-probe.mjs'),harness,mode],{env:process.env,stdout:'pipe',stderr:'pipe'});
 const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect(err).toBe('');expect(exit).toBe(0);
 expect(JSON.parse(out)).toMatchObject({harness,mode,physicalReplacement:true,errorCode:mode==='exact'?null:'CAPTURE_FILE_IDENTITY_UNVERIFIED',statePreservedOnRefusal:true,privateTailExcluded:true,futureAppendCaptured:true,queuedBatchPreserved:true,identityExact:true,historyUnchanged:true,networkInvocations:0,openDescriptors:0});
});
