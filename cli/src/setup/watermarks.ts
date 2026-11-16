import {existsSync,readFileSync,fstatSync,openSync,readSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inventory} from '../capture/backfill.ts';
import {captureDir,type CaptureConfig} from '../capture/runtime.ts';
import {atomicJson} from '../session.ts';
import {transcriptCheckpoint,transcriptIdentity,validTranscriptIdentity} from '../capture/transcript-checkpoint.ts';
import type {TranscriptHarness} from '../capture/parse.ts';
/** Metadata-only no-op check; the repair rereads each state under the spool lock. */
export function hasUnverifiedForwardBoundaries(config:CaptureConfig,harnesses:TranscriptHarness[]){
  for(const harness of harnesses)for(const file of inventory(config,harness).files){
    const stateFile=join(captureDir(),'state',createHash('sha256').update(harness+file.path).digest('hex')+'.json');
    if(!existsSync(stateFile))continue;
    const previous=JSON.parse(readFileSync(stateFile,'utf8'));
    if(previous.forwardBoundary&&!validTranscriptIdentity(previous.identity))return true;
  }
  return false;
}
/** Snapshot byte boundaries, never parse or upload pre-consent conversation content. */
export function establishForwardBoundaries(config:CaptureConfig,harnesses:TranscriptHarness[],{onlyUnverified=false}:{onlyUnverified?:boolean}={}){
  for(const harness of harnesses)for(const file of inventory(config,harness).files){
    const stateFile=join(captureDir(),'state',createHash('sha256').update(harness+file.path).digest('hex')+'.json');
    const previous=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
    if(onlyUnverified&&(!previous.forwardBoundary||validTranscriptIdentity(previous.identity)))continue;
    const fd=openSync(file.path,'r');
    try{
      const source=fstatSync(fd),identity=transcriptIdentity(fd),last=Buffer.alloc(1);
      let partial=false,checkpoint:string|undefined;
      if(!file.path.endsWith('.zst')){if(source.size){readSync(fd,last,0,1,source.size-1);partial=last[0]!==10;}checkpoint=transcriptCheckpoint(fd,source.size);}
      const samePrevious=previous.identity===identity&&Number.isSafeInteger(previous.offset)&&previous.offset>=0&&previous.offset<=source.size&&typeof previous.checkpoint==='string'&&previous.checkpoint===transcriptCheckpoint(fd,previous.offset);
      atomicJson(stateFile,{offset:source.size,ino:source.ino,identity,parserVersion:1,forwardBoundary:true,skipPartial:partial,...(checkpoint?{checkpoint}:{}),...(samePrevious&&previous.meta?{meta:previous.meta}:{}),...(file.path.endsWith('.zst')?{archiveSize:source.size,archiveMtime:source.mtimeMs}: {})});
    }finally{closeSync(fd);}
  }
}
