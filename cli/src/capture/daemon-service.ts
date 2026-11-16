import {existsSync,readFileSync,mkdirSync,unlinkSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {atomicJson,syncDirectory,configDir,withSessionLock} from '../session.ts';
import {captureDir,readCaptureConfig,type CaptureConfig} from './runtime.ts';
import {hash} from './parse.ts';

const directory=()=>join(captureDir(),'daemon');
const label=()=>`com.getopencrawl.capture.${hash(configDir()).slice(0,12)}`;
const xml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function launchAgent(config:CaptureConfig) {
  const args=[...config.command,'collect','daemon'];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label()}</string><key>ProgramArguments</key><array>${args.map(arg=>'<string>'+xml(arg)+'</string>').join('')}</array><key>EnvironmentVariables</key><dict><key>OPENCRAWL_CONFIG_HOME</key><string>${xml(dirname(configDir()))}</string><key>OPENCRAWL_NO_UPDATE</key><string>1</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}

/** Portable fallback for environments whose supervisor starts the worker or
 * keeps detached children alive. A kernel lock, not a PID file, owns singleton
 * exclusion. Hooks never wait for startup, authentication, or upload. */
export async function ensureCaptureDaemon(config=readCaptureConfig()) {
  if(!config||config.disabled||config.claudeCapture!=='daemon-v1'||!config.command.length)return;
  try{await withSessionLock('capture:daemon',async()=>{},0);}catch(error:any){if(error.code==='SESSION_BUSY')return;throw error;}
  const child=spawn(config.command[0]!,[...config.command.slice(1),'collect','daemon'],{detached:true,stdio:'ignore',env:{...process.env,OPENCRAWL_CONFIG_HOME:dirname(configDir()),OPENCRAWL_NO_UPDATE:'1'}});
  child.on('error',()=>{});child.unref();
}

/** macOS is the first supervised proof. Other environments can run the same
 * foreground command under their own supervisor without an init dependency. */
export async function installCaptureDaemon(config:CaptureConfig,{home=homedir(),service=true}:{home?:string,service?:boolean}={}) {
  mkdirSync(directory(),{recursive:true,mode:0o700});
  atomicJson(join(directory(),'generation.json'),{generation:crypto.randomUUID()});
  if(process.platform==='darwin'&&service){
    const path=join(home,'Library','LaunchAgents',label()+'.plist');mkdirSync(dirname(path),{recursive:true});
    const domain='gui/'+process.getuid!();
    spawnSync('launchctl',['bootout',domain+'/'+label()],{stdio:'ignore',timeout:5000});
    // LaunchAgents belongs to the user, not to our config store. Preserve its
    // permissions while atomically replacing only our own service file.
    const temporary=path+'.'+crypto.randomUUID()+'.tmp';
    try{const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,launchAgent(config));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);syncDirectory(dirname(path));}
    finally{try{unlinkSync(temporary);}catch{}}
    const result=spawnSync('launchctl',['bootstrap',domain,path],{stdio:'pipe',timeout:5000});
    if(result.status!==0)throw Error('Could not install the capture LaunchAgent');
    return {kind:'launchd',label:label(),path};
  }
  await ensureCaptureDaemon(config);
  return {kind:'process',command:[...config.command,'collect','daemon']};
}

export function uninstallCaptureDaemon(home=homedir()) {
  // Reconfiguration wakes the worker without trusting a possibly reused PID.
  if(existsSync(directory()))atomicJson(join(directory(),'generation.json'),{generation:crypto.randomUUID()});
  if(process.platform!=='darwin')return;
  const path=join(home,'Library','LaunchAgents',label()+'.plist');
  if(!existsSync(path)||!readFileSync(path,'utf8').includes(xml(dirname(configDir()))))return;
  spawnSync('launchctl',['bootout','gui/'+process.getuid!()+'/'+label()],{stdio:'ignore',timeout:5000});
  unlinkSync(path);
}
