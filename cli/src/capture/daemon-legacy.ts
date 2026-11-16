import {existsSync,readFileSync,readdirSync,lstatSync,unlinkSync,renameSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {atomicJson,syncDirectory} from '../session.ts';
import {captureDir,readCaptureConfig,recordError,orderedNoticeNames,type CaptureConfig,type CaptureHookNotice} from './runtime.ts';
import {sameDaemonBinding,type DaemonNotice} from './daemon-handoff.ts';
import {HARNESSES} from './parse.ts';

/** Compatibility inbox only, never the historical source catalog. The daemon
 * holds the old worker lock, and the durable migration binding prevents these
 * formerly unbound notices from being reassigned after an account/root switch. */
export function importLegacyDaemonNotices(config:CaptureConfig,limit=64){
  const bindingFile=join(captureDir(),'daemon','legacy-handoff.json');
  if(!existsSync(bindingFile)||config.disabled)return false;
  let binding:CaptureConfig;
  try{binding=JSON.parse(readFileSync(bindingFile,'utf8'));if(!binding||!binding.roots)throw Error('Invalid migration binding');}
  catch(error){recordError(error);renameSync(bindingFile,bindingFile+'.held');syncDirectory(dirname(bindingFile));return false;}
  if(!sameDaemonBinding(binding,config)||!isDeepStrictEqual(binding.roots,config.roots))return false;
  const directory=join(captureDir(),'notices');if(!existsSync(directory))return false;
  const names=orderedNoticeNames();
  for(const name of names.slice(0,limit)){
    if(!isDeepStrictEqual(readCaptureConfig(),config))return false;
    const file=join(directory,name);
    try{
      const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>9*1024*1024)throw Error('Invalid legacy notice');
      const record:CaptureHookNotice=JSON.parse(readFileSync(file,'utf8')),at=Date.parse(record.at);
      if(typeof record.id!=='string'||!/^[\w.:-]{1,200}$/.test(record.id)||!Number.isFinite(at)||!HARNESSES.includes(record.harness)||!record.event||typeof record.event!=='object')throw Error('Invalid legacy notice');
      // Existing IDs and sequences survive a crash after publication but before
      // removal. Replaying the same notice cannot invent a second event ID.
      const notice:DaemonNotice={kind:'capture',id:record.id,at,api:config.api,installationId:config.installationId,owner:config.owner,record};
      const sequence=record.sequence??at*1000;
      if(!Number.isSafeInteger(sequence)||sequence<0)throw Error('Invalid legacy sequence');
      const target=join(captureDir(),'daemon','inbox',sequence+'-'+record.id+'.json');
      mkdirSync(dirname(target),{recursive:true,mode:0o700});atomicJson(target,notice);
      unlinkSync(file);syncDirectory(directory);
    }catch(error){
      recordError(error);
      // Retain malformed/oversized bytes visibly; another valid notice proceeds.
      if(existsSync(file)){renameSync(file,file+'.held');syncDirectory(directory);}
    }
  }
  return names.length>limit;
}
