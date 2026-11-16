/** Windows regression for oven-sh/bun#33935. Uses only disposable child
 * processes; no native clients, profiles, services or network. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

if(process.platform!=='win32')throw Error('This subprocess-clock regression requires Windows');
const samples:Record<string,unknown>[]=[];
function invoke(stage:string,command:string,args:string[],timeout:number){
  const startedAt=Date.now();
  const result=spawnSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],windowsHide:true,timeout,maxBuffer:64*1024});
  const finishedAt=Date.now();
  samples.push({stage,startedAt:new Date(startedAt).toISOString(),finishedAt:new Date(finishedAt).toISOString(),elapsedMs:finishedAt-startedAt,timeoutMs:timeout,status:result.status,signal:result.signal,errorCode:(result.error as NodeJS.ErrnoException|undefined)?.code??null,stdout:String(result.stdout??'').trim(),stderr:String(result.stderr??'').slice(0,512)});
  return result;
}
let passed=false;
try{
  const first=invoke('prime-isolated-loop','cmd.exe',['/d','/c','echo opencrawl-clock-first'],1500);
  assert.equal(first.status,0);
  // No synchronous subprocess runs during this idle period. Its duration is
  // intentionally greater than the next call's timeout (the upstream repro).
  await Bun.sleep(2000);
  const second=invoke('after-idle','cmd.exe',['/d','/c','echo opencrawl-clock-after-idle'],1500);
  assert.equal(second.error,undefined,'A fresh call must not inherit an expired timer');
  assert.equal(second.status,0);
  assert.equal(String(second.stdout).trim(),'opencrawl-clock-after-idle');
  // Keep the positive timeout contract: a genuinely hung child must be killed.
  const blocked=invoke('real-timeout',process.execPath,['-e','setTimeout(()=>{},30000)'],500);
  assert.equal((blocked.error as NodeJS.ErrnoException|undefined)?.code,'ETIMEDOUT');
  assert.equal(blocked.status,null);
  assert(Number(samples.at(-1)?.elapsedMs)>=400,'A real 500ms timeout must not fire immediately');
  passed=true;
}finally{
  process.stdout.write(JSON.stringify({schema:1,platform:process.platform,bunVersion:Bun.version,bunRevision:Bun.revision,passed,samples})+'\n');
}
