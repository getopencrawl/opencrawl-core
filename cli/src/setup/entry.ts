import {randomUUID} from 'node:crypto';
import {readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {readCaptureConfig} from '../capture/runtime.ts';
import {apiOrigin,CliError} from '../oauth.ts';
import {atomicJson,withSessionLock} from '../session.ts';
import {setupRoot} from './state.ts';

type Entry={id:string;api?:string};
const entryPath=()=>join(setupRoot(),'interactive.json');

function readEntry():Entry|null{
 try{
  const entry=JSON.parse(readFileSync(entryPath(),'utf8'));
  if(typeof entry?.id==='string'&&(entry.api===undefined||apiOrigin(entry.api)===entry.api))return entry;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;}
 throw new CliError('SETUP_STATE_INVALID','Could not read the saved setup destination.');
}

export const pendingSetupApi=()=>readEntry()?.api;

// Before sign-in we can remember navigation, but only the authenticated scope
// can supply recording choices. A remembered URL is never an explicit token origin.
export function terminalSetupEntry(requestedApi?:string){
 const requested=requestedApi?apiOrigin(requestedApi):undefined;
 const previous=readEntry(),saved=previous&&(!requested||!previous.api||previous.api===requested)?previous:null;
 const config=readCaptureConfig(),api=requested??saved?.api??config?.api;
 const id=randomUUID();
 return {
  api,
  save:(api?:string)=>withSessionLock('setup:terminal-entry',async()=>atomicJson(entryPath(),{id,api})),
  finish:()=>withSessionLock('setup:terminal-entry',async()=>{if(readEntry()?.id===id)unlinkSync(entryPath());}),
 };
}
