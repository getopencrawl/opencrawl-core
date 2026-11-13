import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,rmSync,lstatSync,realpathSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';

export const root=realpathSync(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
export function privateFile(path,value) {
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Refusing symlinked installation state');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(path+'.tmp',typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});
  const fd=openSync(path+'.tmp','r');try{fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(path+'.tmp',path);
  const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
export function run(command,args,{capture=true,input,env={},stdio}={}) {
  const result=spawnSync(command,args,{cwd:root,env:{...process.env,...env},encoding:'utf8',input,
    stdio:stdio??(capture?['pipe','pipe','pipe']:['pipe','inherit','inherit']),maxBuffer:32*1024*1024});
  if(result.status!==0)throw new Error(`${command} ${args[0]||''} failed (${result.status ?? result.error?.code}); existing stores and recovery files are retained.`);
  return result.stdout?.trim()||'';
}
export const docker=(args,options)=>run('docker',args,options);
export function installation(kind='deploy') {
  if(!['deploy','dev'].includes(kind))throw new Error('Use --installation deploy or dev');
  const stateDir=join(root,kind==='dev'?'.opencrawl-dev':'deploy/.upgrade');
  const envFile=join(root,kind==='dev'?'.opencrawl-dev/compose.env':'deploy/.env');
  if(!existsSync(envFile))return null;
  const env=parseEnv(readFileSync(envFile,'utf8'));
  const state=kind==='dev'?JSON.parse(readFileSync(join(stateDir,'state.json'),'utf8')):null;
  if(state&&(state.format!==1||state.root!==root))throw new Error('Saved installation belongs to another clone; use its original checkout');
  const project=state?.project||process.env.COMPOSE_PROJECT_NAME||env.COMPOSE_PROJECT_NAME||'opencrawl';
  if(!/^[a-z0-9][a-z0-9_-]*$/.test(project))throw new Error('Invalid saved Compose project');
  const sqlite=state?.searchBackend==='sqlite'||(process.env.COMPOSE_FILE||env.COMPOSE_FILE||'').includes('compose.sqlite.yaml');
  const files=[join(root,'deploy/compose.yaml'),...(sqlite?[join(root,'deploy/compose.sqlite.yaml')]:[]),...(state?[join(stateDir,'compose.json')]:[])];
  if((process.env.COMPOSE_FILE||env.COMPOSE_FILE||'').split(':').some(f=>f&&!['compose.yaml','compose.sqlite.yaml'].includes(f)))throw new Error('Custom Compose files require an explicitly reviewed migration; use the full application distribution');
  const compose=(args,options={})=>docker(['compose','--project-name',project,'--env-file',envFile,...files.flatMap(f=>['-f',f]),...args],{...options,env:{OPENCRAWL_DATABASE_PASSWORD:env.OPENCRAWL_DATABASE_PASSWORD||'upgrade-preflight-only',...options.env}});
  const configuration=[envFile,...(state?['state.json','compose.json','connectors.env','kubeconfig','seed/seed-input.json','seed/verification.json'].map(f=>join(stateDir,f)):[])].filter(existsSync);
  return {kind,stateDir,envFile,env,state,project,sqlite,files,compose,configuration};
}
export function containers(project) {
  const ids=docker(['ps','-aq','--filter',`label=com.docker.compose.project=${project}`]).split('\n').filter(Boolean);
  return ids.length?JSON.parse(docker(['inspect',...ids])).filter(c=>c.Config.Labels['com.docker.compose.oneoff']!=='True'):[];
}
export function lock(path) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(existsSync(path)) {
    const pid=Number(readFileSync(path,'utf8'));
    if(!Number.isInteger(pid)||pid<1)throw new Error('Invalid operation lock; inspect it before retrying');
    let alive=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw new Error(`Another installation operation is running (PID ${pid})`);
    rmSync(path);
  }
  writeFileSync(path,String(process.pid),{flag:'wx',mode:0o600});
  const release=()=>{if(existsSync(path)&&readFileSync(path,'utf8')===String(process.pid))rmSync(path);};
  process.once('exit',release);return release;
}
