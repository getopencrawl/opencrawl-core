import {existsSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {docker,privateFile,root,lock,shellQuote} from './installation.mjs';
import {verifyRecovery} from './recovery.mjs';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--backup')throw new Error('Usage: node deploy/restore.mjs --backup /private/recovery-directory. Requires empty destination volumes and the saved configuration.');
const directory=resolve(args[1]),snapshot=await verifyRecovery(directory);
const release=lock(join(root,snapshot.kind==='dev'?'.opencrawl-dev/upgrade.lock':'deploy/.upgrade/upgrade.lock'));
try {
 if(docker(['ps','-q','--filter',`label=com.docker.compose.project=${snapshot.project}`]))throw new Error('Stop this installation before restoring; no running installation is overwritten');
 for(const saved of snapshot.configurations) {
  const path=resolve(root,saved.path);
  if(relative(root,path).startsWith('..'))throw new Error('Backup configuration is outside the checkout');
  if(existsSync(path)&&readFileSync(path,'utf8')!==saved.content)throw new Error('Configuration differs from backup. Preserve it elsewhere and remove the conflicting file before restoring: '+saved.path);
 }
 const fd=openSync(join(directory,'images.tar'),'r');
 try{docker(['image','load'],{stdio:[fd,'ignore','inherit']});}finally{closeSync(fd);}
 const mounts=[];
 for(const store of snapshot.stores) {
  const names=docker(['volume','ls','--format','{{.Name}}']).split('\n');
  if(!names.includes(store.name))docker(['volume','create','--label',`com.docker.compose.project=${snapshot.project}`,store.name]);
  const mount=`type=volume,source=${store.name},target=/store`;
  if(docker(['run','--rm','--network','none','--user','0:0','--mount',mount,'--entrypoint','find',snapshot.compose.services.app.image,'/store','-mindepth','1','-print','-quit']))throw new Error('Restore requires empty destination volumes; existing data is never deleted');
  mounts.push('--mount',`type=volume,source=${store.name},target=/stores/${store.key}`);
 }
 const archive=openSync(join(directory,'stores.tgz'),'r');
 try{docker(['run','--rm','-i','--network','none','--user','0:0',...mounts,'--entrypoint','tar',snapshot.compose.services.app.image,'-xzf','-','-C','/stores'],{stdio:[archive,'inherit','inherit']});}finally{closeSync(archive);}
 for(const saved of snapshot.configurations)privateFile(resolve(root,saved.path),saved.content);
 privateFile(join(directory,'restore-compose.json'),snapshot.compose);
 privateFile(join(root,snapshot.kind==='dev'?'.opencrawl-dev/upgrade.json':'deploy/.upgrade/upgrade.json'),{format:1,project:snapshot.project,target:'restored:'+snapshot.compose.services.app.image,phase:'complete'});
 console.log(JSON.stringify({restore:'complete',project:snapshot.project,
  start:`docker compose --project-name ${snapshot.project} -f ${shellQuote(join(directory,'restore-compose.json'))} up -d --wait --wait-timeout 600`,
  warning:'Start the saved images using the command above. Keep the application, PostgreSQL and object-store snapshot together. The separate Airbyte deployment remains operator-managed.'}));
} finally {release();}
