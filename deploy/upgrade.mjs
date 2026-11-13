import {existsSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {installation,containers,privateFile,lock,run,docker,root} from './installation.mjs';
import {snapshot,saveRecovery,verifyRecovery} from './recovery.mjs';

process.umask(0o077);
const args=process.argv.slice(2);let kind='deploy',check=false,backup,automatic=false,record=false,installerPid;
for(let i=0;i<args.length;i++) {
 if(args[i]==='--installation')kind=args[++i];
 else if(args[i]==='--backup')backup=resolve(args[++i]);
 else if(args[i]==='--check')check=true;
 else if(args[i]==='--automatic')automatic=true;
 else if(args[i]==='--record-startup')record=true;
 else if(args[i]==='--installer-pid')installerPid=Number(args[++i]);
 else if(args[i]==='--help'){console.log('Usage: node deploy/upgrade.mjs [--installation deploy|dev] [--check] [--backup /new/private/directory]\nRun from an updated checkout. JSON lines report the plan, durable progress and recovery location. Rerun the same command after a failure.');process.exit(0);}
 else if(!args[i].startsWith('-')&&!backup)backup=resolve(args[i]);
 else throw new Error('Unknown upgrade argument');
}
let current=installation(kind);
if(!current){console.log(JSON.stringify({upgrade:'not-installed',installation:kind}));process.exit(0);}
const target=run('git',['rev-parse','HEAD']),journalFile=join(current.stateDir,'upgrade.json');
let journal=existsSync(journalFile)?JSON.parse(readFileSync(journalFile,'utf8')):null;
let inventory=containers(current.project),app=inventory.find(c=>c.Config.Labels['com.docker.compose.service']==='app');
if(!app&&!journal&&inventory.some(c=>['receiver','mcp','worker','app-db'].includes(c.Config.Labels['com.docker.compose.service'])))throw new Error('No full application container was found. Preserve existing stores and review this installation before upgrading');
if(!app&&!journal){console.log(JSON.stringify({upgrade:'fresh-installation',installation:kind}));process.exit(0);}
if(journal&&journal.project!==current.project)throw new Error('Upgrade journal belongs to another installation');
if(kind==='dev'&&existsSync(join(current.stateDir,'installer.lock'))) {
 const owner=Number(readFileSync(join(current.stateDir,'installer.lock'),'utf8'));
 let alive=true;try{process.kill(owner,0);}catch(e){if(e.code==='ESRCH')alive=false;}
 if(alive&&!(installerPid===owner&&process.ppid===owner))throw new Error('The development installer is already running');
}
if(record) {
 if(journal&&journal.phase!=='complete'&&!(journal.target===target&&journal.phase==='healthy'))throw new Error('Finish the pending upgrade before recording startup');
 privateFile(journalFile,{...journal,format:1,project:current.project,target,phase:'complete',image:app?.Image});
 console.log(JSON.stringify({upgrade:'startup-recorded',target}));process.exit(0);
}
const completed=journal?.phase==='complete'&&journal.target===target&&journal.image===app?.Image;
const needed=!completed;
console.log(JSON.stringify({upgrade:'plan',installation:kind,project:current.project,target,needed,
 previousImage:app?.Image,phase:journal?.phase||'unstarted',backup:journal?.backup||backup||null}));
if(check||!needed)process.exit(0);
const release=lock(join(current.stateDir,'upgrade.lock'));
try {
 // Refresh after acquiring the lock; another completed invocation may have
 // replaced containers or configuration since the read-only plan was printed.
 current=installation(kind);
 journal=existsSync(journalFile)?JSON.parse(readFileSync(journalFile,'utf8')):null;
 inventory=containers(current.project);app=inventory.find(c=>c.Config.Labels['com.docker.compose.service']==='app');
 if(journal?.phase==='complete'&&journal.target===target&&journal.image===app?.Image)process.exit(0);
 if(journal&&(journal.format!==1||!['prepared','built','stopped','backed-up','configured','database-ready','database-transferred','migrated','healthy','complete'].includes(journal.phase)))throw new Error('Unsupported upgrade journal; preserve recovery files for review');
 if(journal&&journal.phase!=='complete'&&journal.target!==target)throw new Error('An upgrade is incomplete. Return to its recorded target revision and resume before upgrading again');
 if(!journal||journal.phase==='complete') {
  backup??=join(current.stateDir,'backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+target.slice(0,12));
  if(existsSync(backup))throw new Error('Use a new backup directory; existing backups are never overwritten');
  const databaseUrl=app.Config.Env.find(value=>value.startsWith('OPENCRAWL_DATABASE_URL='))?.slice('OPENCRAWL_DATABASE_URL='.length);
  const databaseHost=databaseUrl?new URL(databaseUrl).hostname:null;
  if(databaseHost&&!['app-db','temporal-db'].includes(databaseHost))throw new Error('Externally operated databases require a separately reviewed migration');
  // A stopped app-db from an earlier migration is retained recovery data, not
  // the active database for subsequent releases. Never copy it over new writes.
  const active=inventory.filter(c=>c.Config.Labels['com.docker.compose.service']!=='app-db'||databaseHost==='app-db');
  if(databaseHost==='app-db'&&!active.some(c=>c.Config.Labels['com.docker.compose.service']==='app-db'))throw new Error('The active application database container is missing; recover it before upgrading');
  const saved=snapshot(current,active);
  const node=current.kind==='dev'?current.project+'-control-plane':null;
  const nodeIds=node?docker(['ps','-aq','--filter',`name=^/${node}$`]):'';
  let airbyte=null;
  if(nodeIds){const c=JSON.parse(docker(['inspect',nodeIds]))[0];if(c.Config.Labels['io.x-k8s.kind.cluster']!==current.project)throw new Error('Airbyte node ownership mismatch');airbyte={id:c.Id,running:c.State.Running};}
  journal={format:1,project:current.project,target,backup,phase:'prepared',snapshot:saved,containerIds:inventory.map(c=>c.Id),writerIds:inventory.filter(c=>['app','worker'].includes(c.Config.Labels['com.docker.compose.service'])).map(c=>c.Id),airbyte,
   databasePassword:current.env.OPENCRAWL_DATABASE_PASSWORD||randomBytes(24).toString('hex'),
   airbyteEnabled:process.env.OPENCRAWL_AIRBYTE_ENABLED??app.Config.Env.find(value=>value.startsWith('OPENCRAWL_AIRBYTE_ENABLED='))?.split('=').slice(1).join('=')??'true',
   legacyDatabase:databaseHost==='app-db'?(inventory.find(c=>c.Config.Labels['com.docker.compose.service']==='app-db')?.Id||null):null};
  privateFile(journalFile,journal);
 }
 const phases=['prepared','built','stopped','backed-up','configured','database-ready','database-transferred','migrated','healthy','complete'];
 const done=phase=>phases.indexOf(journal.phase)>=phases.indexOf(phase);
 const mark=phase=>{journal.phase=phase;if(phase==='complete')journal.image=containers(current.project).find(c=>c.Config.Labels['com.docker.compose.service']==='app')?.Image;privateFile(journalFile,journal);console.log(JSON.stringify({upgrade:'progress',phase,backup:journal.backup}));};
 if(!done('built')){current.compose(['build','app'],{capture:false,env:{OPENCRAWL_DATABASE_PASSWORD:journal.databasePassword}});mark('built');}
 if(!done('stopped')){
  if(journal.airbyte?.running)docker(['stop',journal.airbyte.id]);
  // Drain requests and activities while their backing services are still up.
  const writers=journal.writerIds||inventory.filter(c=>['app','worker'].includes(c.Config.Labels['com.docker.compose.service'])).map(c=>c.Id);
  if(writers.length)docker(['stop',...writers]);
  const dependencies=journal.containerIds.filter(id=>!writers.includes(id));
  if(dependencies.length)docker(['stop',...dependencies]);mark('stopped');
 }
 if(!done('backed-up')){await saveRecovery(journal.backup,journal.snapshot);mark('backed-up');}
 else await verifyRecovery(journal.backup);
 if(!done('configured')) {
  let text=readFileSync(current.envFile,'utf8');
  if(!current.env.OPENCRAWL_DATABASE_PASSWORD)text+='\nOPENCRAWL_DATABASE_PASSWORD='+journal.databasePassword+'\n';
  text=text.replace(/^OPENCRAWL_AIRBYTE_ENABLED=.*$/m,'OPENCRAWL_AIRBYTE_ENABLED='+journal.airbyteEnabled);
  if(!/^OPENCRAWL_AIRBYTE_ENABLED=/m.test(text))text+='\nOPENCRAWL_AIRBYTE_ENABLED='+journal.airbyteEnabled+'\n';
  privateFile(current.envFile,text);
  if(current.state){current.state.databasePassword=journal.databasePassword;privateFile(join(current.stateDir,'state.json'),current.state);}
  current=installation(kind);mark('configured');
 }
 {
  current.compose(['up','-d','--wait','--wait-timeout','300','temporal-db','s3'],{capture:false});
  current.compose(['run','--rm','--no-deps','database-ready'],{capture:false});if(!done('database-ready'))mark('database-ready');
 }
 if(!done('database-transferred')){
  if(journal.legacyDatabase) {
   docker(['start',journal.legacyDatabase]);
   // The old server remains isolated from application writers. Its UUID, every
   // reservation and every deletion fence are copied and hashed transactionally.
   current.compose(['run','--rm','--no-deps','app','node','deploy/database-transfer.mjs'],{capture:false});
   docker(['stop',journal.legacyDatabase]);
  }
  mark('database-transferred');
 }
 if(!done('migrated')){
  current.compose(['run','--rm','--no-deps','app','node','dist/src/sessions/identity-migration.mjs','migrate'],{capture:false});mark('migrated');
 }
 {
  current.compose(['up','-d','--wait','--wait-timeout','600','app','worker'],{capture:false});mark('healthy');
 }
 if(current.kind==='dev') {
  console.log(JSON.stringify({upgrade:'core-ready',project:current.project,target,backup:journal.backup}));
  if(!automatic) {
   release();
   run(process.execPath,[join(root,'dev/installer.mts'),'up',...(current.state.airbyteEnabled===false?['--no-airbyte']:[])],{capture:false});
  }
 } else mark('complete');
 if(!automatic||current.kind==='deploy')console.log(JSON.stringify({upgrade:'complete',project:current.project,target,backup:journal.backup}));
} catch(error) {
 if(journal&&['stopped','backed-up','configured','database-ready','database-transferred','migrated','healthy'].includes(journal.phase)) {
  try {
   const writers=containers(current.project).filter(c=>['app','worker'].includes(c.Config.Labels['com.docker.compose.service']));
   if(writers.length)docker(['stop',...writers.map(c=>c.Id)]);
   if(journal.airbyte?.running)docker(['stop',journal.airbyte.id]);
  } catch {console.error(JSON.stringify({upgrade:'writers-stop-unconfirmed',project:current.project,action:'Check the application, worker and Airbyte node before resuming'}));}
 }
 console.error(JSON.stringify({upgrade:'failed',phase:journal?.phase,backup:journal?.backup,error:error.message,
  resume:`node deploy/upgrade.mjs --installation ${kind}`,recovery:'node deploy/restore.mjs --backup '+(journal?.backup||'BACKUP')}));
 process.exitCode=1;
} finally {release();}
