import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,statSync,unlinkSync} from 'node:fs';
import {CliError} from '../oauth.ts';
import {atomicFile,sessionFile,withSessionLock} from '../session.ts';

const key='setup:interactive-choices';
const lockFile=()=>sessionFile(key)+'.lock';
function owner(file:string){
  const pid=Number(readFileSync(file,'utf8'));
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Missing lock owner');
  const stat=statSync(file,{bigint:true});
  return {pid,stamp:[pid,stat.dev,stat.ino,stat.ctimeNs].join(':')};
}

// The PID marker is shared with older CLIs. Tag this acquisition separately so
// unattended apply, plugin refresh and doctor never look like an open wizard.
export function withSetupChoices<T>(run:()=>Promise<T>,wizard:boolean){
  return withSessionLock(key,async()=>{
    if(!wizard)return run();
    const file=lockFile(),tag=file+'.wizard';
    try{atomicFile(tag,owner(file).stamp);}catch{/* Diagnostic only. */}
    try{return await run();}finally{try{unlinkSync(tag);}catch{/* An old tag cannot match a new acquisition. */}}
  },0);
}

function wizardLocation(){
  try{
    const file=lockFile(),held=owner(file);
    process.kill(held.pid,0);
    let marked=false;
    try{marked=readFileSync(file+'.wizard','utf8')===held.stamp;}catch{/* Older wizard. */}
    let terminal:string|undefined,legacy=false;
    if(process.platform!=='win32'){
      try{
        const row=execFileSync('/bin/ps',['-ww','-p',String(held.pid),'-o','tty=','-o','command='],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}).trim();
        const match=/^(tty[\w.-]+|pts\/\d+|console|[ts]\d+)\s+(.+)$/.exec(row);
        terminal=match?.[1];
        legacy=!!match&&/^(?:\/[^\r\n]*\/)?opencrawl\s+setup(?:\s+--api\s+\S+)?$/.test(match[2]!);
      }catch{/* Terminal lookup is best effort. */}
    }
    if((marked||legacy)&&owner(file).stamp===held.stamp)return terminal??'its terminal (PID '+held.pid+')';
  }catch{/* The owner might already have exited. */}
}

export async function withDoctorSetupChoices<T>(run:()=>Promise<T>){
  let entered=false;
  try{return await withSessionLock(key,()=>{entered=true;return run();},0);}
  catch(error){
    if(!entered&&error instanceof CliError&&error.code==='SESSION_BUSY'){
      const location=wizardLocation();
      if(location)throw new CliError('SETUP_WIZARD_OPEN','Finish or cancel opencrawl setup in '+location+', then rerun opencrawl doctor.');
    }
    throw error;
  }
}

export async function checkRunningSetup(){
  // A first-time wizard may still be choosing, without a saved configuration.
  if(existsSync(lockFile()))await withDoctorSetupChoices(async()=>{});
}
