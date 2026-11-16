/** Explicit acceptance probe: installs only a disposable, profile-bound OS
 * service. No native client settings, credentials, or production endpoint. */
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,createReadStream,copyFileSync,constants} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {installCaptureDaemon,uninstallCaptureDaemon} from '../src/capture/daemon-service.ts';
import {captureDir,type CaptureConfig} from '../src/capture/runtime.ts';
import {atomicJson,withSessionLock} from '../src/session.ts';

const evidence=process.argv[2];if(!evidence)throw Error('Supply an evidence directory');mkdirSync(evidence,{recursive:true});
const directory=realpathSync(mkdtempSync(join(tmpdir(),'opencrawl-supervisor-proof-'))),before={...process.env},native=process.argv[3],previousNative=process.argv[4];
const receipt:any={platform:process.platform,execution:native?'compiled-native':'source',startedAt:new Date().toISOString(),passed:false};
let pid:number|undefined,installed=false,serviceRemoved=false,workerStopped=false;
const observedPids=new Set<number>();
const alive=(id:number)=>{try{process.kill(id,0);return true;}catch{return false;}};
const wait=async(check:()=>boolean,ms:number)=>{const deadline=Date.now()+ms;while(!check()){if(Date.now()>deadline)throw Error('Supervisor did not reach the expected state before the deadline');await Bun.sleep(100);}};
const home=process.platform==='darwin'?directory:homedir();
try{
  if(previousNative&&(!native||process.platform!=='darwin'))throw Error('A previous packaged binary is supported only for the compiled Mac replacement probe');
  Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(directory,'config'),XDG_CACHE_HOME:join(directory,'cache'),XDG_DATA_HOME:join(directory,'data'),OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_TOKEN:'',OPENCRAWL_SESSIONS_TOKEN:'',OPENCRAWL_AUTH:'',OPENCRAWL_API_URL:'http://127.0.0.1:1'});
  const config:CaptureConfig={schemaVersion:1,captureWorker:'daemon-v1',api:'http://127.0.0.1:1',installationId:'supervisor-proof',owner:{tenantId:'fixture',userId:'fixture'},installedAt:new Date().toISOString(),harnesses:['claude-code'],roots:{'claude-code':join(directory,'claude'),codex:join(directory,'codex')},
    command:native?[resolve(native)]:[process.execPath,resolve(import.meta.dir,'../src/cli.ts')]};
  mkdirSync(captureDir(),{recursive:true});atomicJson(join(captureDir(),'config.json'),config);
  installed=true;const service=await installCaptureDaemon(config,{home});receipt.service=service;
  if(!service.supervised)throw Error('No native supervisor available; external lifecycle proof is required');
  const status=()=>{try{const current=JSON.parse(readFileSync(join(captureDir(),'daemon','status.json'),'utf8'));if(Number.isSafeInteger(current?.pid)&&current.pid>0)observedPids.add(current.pid);return current;}catch{return null;}};
  await wait(()=>status()?.state==='running'&&alive(status().pid),20_000);pid=status().pid;receipt.initialPid=pid;
  receipt.worker={executable:status().executable,version:status().version,compiled:status().compiled};
  if(realpathSync(status().executable)!==realpathSync(native?resolve(native):process.execPath))throw Error('Supervisor ran a different executable');
  if(native){
    if(!status().compiled)throw Error('Expected a compiled native worker');
    const manifest=JSON.parse(readFileSync(join(dirname(dirname(resolve(native))),'package.json'),'utf8'));
    if(!/^[a-f0-9]{40}$/.test(manifest.opencrawlRevision??'')||manifest.version!==status().version)throw Error('Packaged worker provenance does not match its running version');
    const digest=createHash('sha256');for await(const chunk of createReadStream(native))digest.update(chunk);
    receipt.worker.sourceRevision=manifest.opencrawlRevision;receipt.worker.sha256=digest.digest('hex');
  }
  if(process.platform==='darwin'&&native){
    // Exercise changed definitions, not only crash restart or an unchanged
    // managed path. A supplied prior package additionally proves version change.
    const other=join(directory,'replacement','bin','opencrawl');mkdirSync(dirname(other),{recursive:true});
    copyFileSync(previousNative?resolve(previousNative):resolve(native),other,constants.COPYFILE_FICLONE);
    const otherManifest=JSON.parse(readFileSync(join(dirname(dirname(resolve(previousNative??native))),'package.json'),'utf8'));
    if(!/^[a-f0-9]{40}$/.test(otherManifest.opencrawlRevision??''))throw Error('Replacement package has no source revision');
    if(previousNative&&otherManifest.version===receipt.worker.version)throw Error('Previous package must have a different version');
    const digest=createHash('sha256');for await(const chunk of createReadStream(other))digest.update(chunk);
    receipt.replacement={kind:previousNative?'different-package-version':'same-binary-different-path',otherVersion:otherManifest.version,otherRevision:otherManifest.opencrawlRevision,otherSha256:digest.digest('hex'),steps:[]};
    for(const executable of [other,resolve(native),other,resolve(native)]){
      const beforePid=pid,next={...config,command:[executable]},startedAt=performance.now();
      atomicJson(join(captureDir(),'config.json'),next);
      const replaced=await installCaptureDaemon(next,{home});
      if(!replaced.supervised)throw Error('Replacement did not establish native supervision');
      await wait(()=>{const current=status();return current?.state==='running'&&current.pid!==beforePid&&alive(current.pid)&&!alive(beforePid!)&&current.executable&&realpathSync(current.executable)===realpathSync(executable);},20_000);
      pid=status().pid;
      const expectedVersion=executable===other?otherManifest.version:receipt.worker.version;
      if(!status().compiled||status().version!==expectedVersion)throw Error('Replacement worker version or executable differs');
      receipt.replacement.steps.push({pid,executable:status().executable,version:status().version,elapsedMs:performance.now()-startedAt});
    }
  }
  const killedAt=performance.now();process.kill(pid!,'SIGKILL');
  await wait(()=>status()?.state==='running'&&status().pid!==pid&&alive(status().pid),90_000);
  pid=status().pid;receipt.restartedPid=pid;receipt.restartMs=performance.now()-killedAt;
  if(process.platform==='win32'){
    // Keep the restart deadline above unchanged; observe the same worker across
    // a subsequent one-minute recovery interval before testing uninstall.
    const stableAt=performance.now(),stableForMs=65_000;
    while(performance.now()-stableAt<stableForMs){
      const current=status();
      if(current?.state!=='running'||current.pid!==pid||!alive(pid!))throw Error('Restarted worker did not stay running across the recovery interval');
      await Bun.sleep(100);
    }
    const current=status();
    if(current?.state!=='running'||current.pid!==pid||!alive(pid!))throw Error('Restarted worker changed at the end of the recovery interval');
    receipt.restartStability={pid,observedMs:performance.now()-stableAt,recoveryIntervalMs:60_000,samePidRunning:true};
  }
  uninstallCaptureDaemon(home);installed=false;serviceRemoved=true;await wait(()=>!alive(pid!),10_000);
  await withSessionLock('capture:daemon',async()=>{},0);workerStopped=true;
  receipt.uninstallStoppedWorker=true;receipt.passed=true;
}catch(error){receipt.error=error instanceof Error?error.message:'Supervisor proof failed';process.exitCode=1;}
finally{
  if(installed)try{uninstallCaptureDaemon(home);serviceRemoved=true;}catch(error){receipt.cleanupError=String(error);process.exitCode=1;}
  if(serviceRemoved)try{
    await wait(()=>[...observedPids].every(id=>!alive(id)),10_000);
    await withSessionLock('capture:daemon',async()=>{},0);workerStopped=true;
  }catch{workerStopped=false;receipt.cleanupWorkerUnconfirmed=true;process.exitCode=1;}
  // No PID is not proof of no process. The supervisor must be removed and the
  // kernel singleton released before this profile can be safely discarded.
  if(serviceRemoved&&workerStopped)rmSync(directory,{recursive:true,force:true});else receipt.retainedProfile=directory;
  for(const name of Object.keys(process.env))if(!(name in before))delete process.env[name];Object.assign(process.env,before);
  if(!serviceRemoved||!workerStopped||receipt.cleanupError||receipt.cleanupWorkerUnconfirmed)receipt.passed=false;
  receipt.finishedAt=new Date().toISOString();writeFileSync(join(evidence,'supervisor-'+process.platform+'.json'),JSON.stringify(receipt,null,2)+'\n');
  process.stdout.write(JSON.stringify(receipt)+'\n');
}
