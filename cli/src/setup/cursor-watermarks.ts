import {existsSync,readdirSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {atomicJson,withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {captureDir,readCaptureConfig,recordError,type CaptureConfig} from '../capture/runtime.ts';
import {cursorTranscriptBoundary} from '../capture/cursor.ts';
import {validTranscriptIdentity} from '../capture/transcript-checkpoint.ts';
import {hash} from '../capture/parse.ts';
import {cursorCliStores,cursorEditorSessions,cursorStoreRecords} from '../capture/cursor-store.ts';

/** At enrollment, save the committed references of older stores. This lets
 * the first post-consent turn arrive while the daemon is offline. No message
 * blobs from the old head are read, queued or uploaded. */
export async function establishCursorStoreBoundaries(config:CaptureConfig,expected:CaptureConfig|null){
 const root=config.roots.cursor,selectedAt=config.discoverySince?.cursor;
 if(!root||selectedAt===undefined)return;
 const since=selectedAt;
 async function save(root:string,id:string,path:string){
  if(!existsSync(path))return;
  await withSessionLock('capture:cursor:'+id,async()=>{
   if(!isDeepStrictEqual(readCaptureConfig(),expected))throw new CliError('CAPTURE_CONFIG_CHANGED','Cursor recording changed before its native boundary was saved.');
   let baseline;
   try{baseline=cursorStoreRecords(root,id,path,since,undefined,true);}catch(error){
    // An unsupported historical store cannot contribute bytes. If its native
    // format later becomes readable, that reader establishes a fresh baseline.
    recordError(error);return;
   }
   if(!baseline)return;
   const file=join(captureDir(),'state','cursor-'+hash(id)+'.json');
   const state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{offset:0,hooks:{},transcript:{},emitted:{}};
   atomicJson(file,{...state,storeSince:since,storeCursor:baseline.cursor,storeScannedAt:new Date(since).toISOString()});
  });
 }
 for(const chat of cursorCliStores(root))await save(root,chat.id,chat.path);
 const editor=config.cursorEditorRoot;
 if(editor){
  let rows;try{rows=cursorEditorSessions(editor,0);}catch(error){recordError(error);return;}
  for(const row of rows)await save(editor,row.id,join(editor,'state.vscdb'));
 }
}

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
