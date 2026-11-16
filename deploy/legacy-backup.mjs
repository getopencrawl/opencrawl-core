// Read compatibility only for backups made before matched image recovery.
import {readFileSync,writeFileSync,existsSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest} from './recovery.mjs';
import {root,lock} from './installation.mjs';

export async function restoreLegacyBackup(directory) {
  const cwd=join(root,'deploy'),env=join(cwd,'.env');
  const release=lock(join(cwd,'.upgrade/upgrade.lock'));
  function compose(args,stdio='pipe') {
    const result=spawnSync('docker',['compose',...args],{cwd,stdio,encoding:stdio==='pipe'?'utf8':undefined});
    if(result.status!==0)throw new Error('Legacy backup restore failed; preserve the backup and destination stores');
    return result.stdout?.trim()||'';
  }
  try {
    const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
    const revision=spawnSync('git',['rev-parse','HEAD'],{cwd,encoding:'utf8'});
    if(revision.status!==0||revision.stdout.trim()!==manifest.revision)throw new Error('Check out the source revision recorded in manifest.json before restoring a format 1 backup');
    if(manifest.format!==1||await digest(join(directory,'stores.tgz'))!==manifest.storesSha256||await digest(join(directory,'environment'))!==manifest.environmentSha256)throw new Error('Backup integrity verification failed');
    const savedEnv=readFileSync(join(directory,'environment'));
    if(existsSync(env)&&!readFileSync(env).equals(savedEnv))throw new Error('Current deployment credentials differ; use the matching saved configuration');
    if(!existsSync(env))writeFileSync(env,savedEnv,{mode:0o600,flag:'wx'});
    if(compose(['ps','--status','running','-q']))throw new Error('Stop the destination stack before restoring');
    if(compose(['run','--rm','--no-deps','-T','backup','find','/data','-mindepth','2','-print','-quit']))throw new Error('Restore requires empty destination volumes; existing data is never removed');
    const fd=openSync(join(directory,'stores.tgz'),'r');
    try{compose(['run','--rm','--no-deps','-T','backup','tar','-xzf','-','-C','/data'],[fd,'inherit','inherit']);}
    finally{closeSync(fd);}
    console.log(JSON.stringify({restore:'complete',format:1,revision:manifest.revision,warning:'Start the exact recorded source revision and verify login, capture, search and board data.'}));
  } finally {release();}
}
