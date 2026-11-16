import {existsSync,readdirSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {atomicJson,withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {captureDir,readCaptureConfig,type CaptureConfig} from '../capture/runtime.ts';
import {cursorTranscriptBoundary} from '../capture/cursor.ts';
import {validTranscriptIdentity} from '../capture/transcript-checkpoint.ts';
import {hash} from '../capture/parse.ts';

/** Explicit enrollment only. The worker never enumerates a native history tree. */
export async function establishCursorForwardBoundaries(config:CaptureConfig,expectedConfig:CaptureConfig|null,{onlyUnverified=false}:{onlyUnverified?:boolean}={}){
 const root=config.roots.cursor;if(!root)return;
 const dirs=(path:string)=>existsSync(path)?readdirSync(path,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).map(entry=>entry.name).sort():[];
 for(const project of dirs(join(root,'projects'))){
  const transcripts=join(root,'projects',project,'agent-transcripts');
  if(!existsSync(transcripts)||lstatSync(transcripts).isSymbolicLink())continue;
  for(const sessionId of dirs(transcripts)){
   if(!/^[\w.:-]{1,200}$/.test(sessionId))continue;
   const file=join(transcripts,sessionId,sessionId+'.jsonl');
   if(!existsSync(file)||!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink())continue;
   await withSessionLock('capture:cursor:'+sessionId,async()=>{
    const current=readCaptureConfig();
    if(!isDeepStrictEqual(current,expectedConfig))throw new CliError('CAPTURE_CONFIG_CHANGED','Cursor recording changed before its consent boundary was saved.');
    const stateFile=join(captureDir(),'state','cursor-'+hash(sessionId)+'.json');
    // Refuse malformed saved state instead of hiding damage during enrollment.
    const previous=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{};
    if(onlyUnverified&&(!previous.forwardBoundary||validTranscriptIdentity(previous.identity)))return;
    const boundary=cursorTranscriptBoundary(root,sessionId,file);
    atomicJson(stateFile,{...boundary,forwardBoundary:true,hooks:{},transcript:{},emitted:{}});
   });
  }
 }
}
