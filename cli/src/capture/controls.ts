import {existsSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {atomicJson, withSessionLock} from '../session.ts';
import {CliError} from '../oauth.ts';
import {captureDir, readCaptureConfig} from './runtime.ts';
import {projectPath} from './policy.ts';

export async function approveCapture(approved:boolean, json:boolean, notice:string) {
  if(approved)return true;
  if(json || !process.stdin.isTTY || !process.stderr.isTTY)return false;
  process.stderr.write(notice+'\n');
  const input=createInterface({input:process.stdin,output:process.stderr});
  try{return /^(y|yes)$/i.test((await input.question('Enable capture? [y/N] ')).trim());}
  finally{input.close();}
}

export async function excludeCapture(project?:string, session?:string) {
  if(Boolean(project)===Boolean(session))throw new CliError('INVALID_USAGE','Choose one of --project /absolute/path or --session-id ID.',64);
  if(session && !/^[\w.:-]{1,200}$/.test(session))throw new CliError('INVALID_USAGE','Invalid session ID.',64);
  let normalized:string|undefined;
  try{if(project)normalized=projectPath(project);}catch{throw new CliError('INVALID_USAGE','Use an absolute project directory.',64);}
  // A committed exclusion fences uploads. An already running upload completes first.
  return withSessionLock('capture:flush',()=>withSessionLock('capture:configuration',async()=>{
    const config=readCaptureConfig();
    if(!config)throw new CliError('CAPTURE_NOT_INSTALLED','Run collect install first.');
    const exclusions={projects:[...(config.exclusions?.projects??[])],sessions:[...(config.exclusions?.sessions??[])]};
    const list=normalized?exclusions.projects:exclusions.sessions;
    if(!list.includes(normalized??session!))list.push(normalized??session!);
    atomicJson(join(captureDir(),'config.json'),{...config,exclusions});
    return {exclusions,notice:'New capture and queued uploads matching these exclusions are blocked. Previously uploaded data is unchanged. Unknown working directories are blocked while project exclusions exist.'};
  },Infinity),Infinity);
}

export async function purgeLocalCapture(approved:boolean) {
  if(!approved)throw new CliError('PURGE_CONSENT_REQUIRED','Run collect uninstall, then collect purge --yes to permanently delete local pending capture data. Uploaded data is unchanged.',64);
  // Never remove lock databases: another process may still have one open.
  return withSessionLock('capture:memories',()=>withSessionLock('capture:worker',()=>withSessionLock('capture:notices',()=>withSessionLock('capture:spool',()=>withSessionLock('capture:flush',()=>withSessionLock('capture:configuration',async()=>{
    const config=readCaptureConfig();
    if(!config?.disabled)throw new CliError('CAPTURE_ACTIVE','Run collect uninstall and wait for active capture to stop before purging.');
    for(const name of ['queue','blobs','notices','sources','state','memories','last-upload.json','last-error.json']) {
      const path=join(captureDir(),name);
      if(existsSync(path))rmSync(path,{recursive:true,force:true});
    }
    return {localCaptureDataDeleted:true,uploadedDataDeleted:false,notice:'Original harness transcripts, credentials and hook backups are unchanged. Reinstalling can capture active conversations again; retain exclusions for sensitive projects.'};
  },0),0),0),0),0),0);
}
