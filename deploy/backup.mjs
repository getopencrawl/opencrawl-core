import {spawnSync} from 'node:child_process';
import {createReadStream,readFileSync,writeFileSync,existsSync,mkdirSync,openSync,closeSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=dirname(fileURLToPath(import.meta.url)),[action,destination]=process.argv.slice(2);
if(!['create','restore'].includes(action)||!destination)throw new Error('Usage: node deploy/backup.mjs create|restore /absolute/backup-directory');
const backup=resolve(destination),env=join(cwd,'.env');
function compose(args,stdio='pipe') {
  const result=spawnSync('docker',['compose',...args],{cwd,stdio,encoding:stdio==='pipe'?'utf8':undefined});
  if(result.status!==0)throw new Error('Docker backup operation failed; preserve the backup and inspect the stopped stack.');
  return result.stdout?.trim()||'';
}
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
if(action==='create') {
  if(existsSync(backup))throw new Error('Choose a new backup directory; existing backups are never overwritten.');
  if(!compose(['ps','--status','running','-q']))throw new Error('Start the stack before creating an offline backup.');
  mkdirSync(backup,{mode:0o700});
  compose(['stop']);
  try {
    writeFileSync(join(backup,'environment'),readFileSync(env),{mode:0o600,flag:'wx'});
    const partial=join(backup,'stores.tgz.partial'),fd=openSync(partial,'wx',0o600);
    try{compose(['run','--rm','--no-deps','-T','backup','tar','-czf','-','-C','/data','.'],['ignore',fd,'inherit']);}
    finally{closeSync(fd);}
    renameSync(partial,join(backup,'stores.tgz'));
    const revision=spawnSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});
    if(revision.status!==0)throw new Error('Cannot record source revision.');
    writeFileSync(join(backup,'manifest.json'),JSON.stringify({format:1,revision:revision.stdout.trim(),
      storesSha256:await digest(join(backup,'stores.tgz')),environmentSha256:await digest(join(backup,'environment'))},null,2)+'\n',{mode:0o600,flag:'wx'});
  }finally{compose(['up','-d','--wait','--wait-timeout','240'],'inherit');}
} else {
  const manifest=JSON.parse(readFileSync(join(backup,'manifest.json'),'utf8'));
  const revision=spawnSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});
  if(revision.status!==0||revision.stdout.trim()!==manifest.revision)throw new Error('Check out the source revision recorded in manifest.json before restoring.');
  if(manifest.format!==1||await digest(join(backup,'stores.tgz'))!==manifest.storesSha256||await digest(join(backup,'environment'))!==manifest.environmentSha256)throw new Error('Backup integrity verification failed.');
  const savedEnv=readFileSync(join(backup,'environment'));
  if(existsSync(env)&&!readFileSync(env).equals(savedEnv))throw new Error('Current deployment credentials differ. Restore in a separate checkout with the backup environment.');
  if(!existsSync(env))writeFileSync(env,savedEnv,{mode:0o600,flag:'wx'});
  if(compose(['ps','--status','running','-q']))throw new Error('Stop the destination stack before restoring.');
  const existing=compose(['run','--rm','--no-deps','-T','backup','find','/data','-mindepth','2','-print','-quit']);
  if(existing)throw new Error('Restore requires empty destination volumes. Existing data is never removed.');
  const fd=openSync(join(backup,'stores.tgz'),'r');
  try{compose(['run','--rm','--no-deps','-T','backup','tar','-xzf','-','-C','/data'],[fd,'inherit','inherit']);}
  finally{closeSync(fd);}
  console.log('Restored stores. Start the recorded source revision and verify capture, search and board data.');
}
console.log('Backup '+action+' complete: '+backup);
