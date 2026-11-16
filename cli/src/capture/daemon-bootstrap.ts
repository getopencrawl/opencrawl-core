import {existsSync,readFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {atomicJson,syncDirectory} from '../session.ts';
import {captureDir,readCaptureConfig,captureDaemonEnabled,type CaptureConfig} from './runtime.ts';

export type DaemonBootstrap={id:string;expiresAt:number;before:CaptureConfig;candidate:CaptureConfig};
export const bootstrapFile=()=>join(captureDir(),'daemon','bootstrap.json');
export const readinessFile=()=>join(captureDir(),'daemon','bootstrap-ready.json');
export function readBootstrap():DaemonBootstrap|null {
  try{return JSON.parse(readFileSync(bootstrapFile(),'utf8'));}catch(error:any){if(error.code==='ENOENT')return null;throw error;}
}
/** A staged service proves its actual executable can start without capturing or
 * taking the legacy worker lock. The old collector remains authoritative until
 * the migration publishes candidate. No credentials or transcript are read. */
export async function awaitDaemonActivation({signal,pollMs=50}:{signal?:AbortSignal;pollMs?:number}={}) {
  if(captureDaemonEnabled())return true;
  const stage=readBootstrap();
  if(!stage||stage.expiresAt<=Date.now()||!isDeepStrictEqual(readCaptureConfig(),stage.before))return false;
  atomicJson(readinessFile(),{id:stage.id,pid:process.pid});
  while(!signal?.aborted&&Date.now()<stage.expiresAt){
    if(readBootstrap()?.id!==stage.id)return false;
    if(isDeepStrictEqual(readCaptureConfig(),stage.candidate))return true;
    if(!isDeepStrictEqual(readCaptureConfig(),stage.before))return false;
    try{await sleep(pollMs,undefined,{signal});}catch{return false;}
  }
  return false;
}
export async function waitForDaemonReady(stage:DaemonBootstrap,timeoutMs=10_000){
  const deadline=Math.min(stage.expiresAt,Date.now()+timeoutMs);
  while(Date.now()<deadline){
    if(!isDeepStrictEqual(readCaptureConfig(),stage.before)||readBootstrap()?.id!==stage.id)return false;
    if(existsSync(readinessFile())){
      const ready=JSON.parse(readFileSync(readinessFile(),'utf8'));
      if(ready.id===stage.id&&Number.isSafeInteger(ready.pid)&&ready.pid>0){try{process.kill(ready.pid,0);return true;}catch{}}
    }
    await sleep(50);
  }
  return false;
}
export function cancelDaemonBootstrap(id:string){
  if(readBootstrap()?.id===id){unlinkSync(bootstrapFile());syncDirectory(join(captureDir(),'daemon'));}
}
