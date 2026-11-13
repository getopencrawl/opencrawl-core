import {spawnSync} from 'node:child_process';
import {readFileSync,appendFileSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=dirname(fileURLToPath(import.meta.url));
const [destination]=process.argv.slice(2);
if(process.argv.length!==3||!destination)throw new Error('Usage: node deploy/upgrade.mjs /absolute/new-backup-directory');
const backup=resolve(destination);
if(existsSync(backup))throw new Error('Use a new backup directory; existing backups are never overwritten.');
const env=join(cwd,'.env'),text=readFileSync(env,'utf8');
if(!/^OPENCRAWL_DATABASE_PASSWORD=.+$/m.test(text))appendFileSync(env,'\nOPENCRAWL_DATABASE_PASSWORD='+randomBytes(24).toString('hex')+'\n',{mode:0o600});
function run(command,args,capture=false){
 const result=spawnSync(command,args,{cwd,stdio:capture?'pipe':'inherit',encoding:'utf8'});
 if(result.status!==0)throw new Error('Upgrade incomplete. Preserve the backup and keep writers stopped; fix the failure and rerun the migration command in docs/event-identity-migration.md.');
 return result.stdout?.trim()||'';
}
const compose=(args,capture=false)=>run('docker',['compose',...args],capture);
const services=compose(['config','--services'],true).split('\n'),receiver=services.includes('app')?'app':'receiver';
// Build before downtime; do not replace running services yet.
compose(['build',receiver]);
run(process.execPath,[join(cwd,'backup.mjs'),'create',backup,'--leave-stopped']);
compose(['up','-d','--wait','--wait-timeout','240','app-db','s3']);
compose(['run','--rm','--no-deps',receiver,'node','dist/src/sessions/identity-migration.mjs','migrate']);
compose(['up','-d','--wait','--wait-timeout','600']);
console.log('PostgreSQL identity migration and upgrade complete. Backup: '+backup);
