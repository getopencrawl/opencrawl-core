// Disposable CI acceptance only. This intentionally replaces the checkout and
// deletes its own labeled test volumes to exercise a real matched restore.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
if(process.env.CI!=='true')throw new Error('Run this destructive acceptance harness only in its disposable CI job');
const root=process.cwd(),scratch=join(process.env.RUNNER_TEMP,'full-upgrade');mkdirSync(scratch,{recursive:true});
const target=process.env.UPGRADE_TARGET,old=process.env.UPGRADE_FROM,kind=process.env.UPGRADE_INSTALLATION||'deploy',sqlite=process.env.UPGRADE_SQLITE==='true',airbyte=process.env.UPGRADE_AIRBYTE==='true';
const large=kind==='deploy'&&!sqlite;
assert.match(target,/^[a-f0-9]{40}$/);assert.match(old,/^[a-f0-9]{40}$/);
const env={...process.env,OPENCRAWL_AIRBYTE_ENABLED:String(airbyte),OPENCRAWL_URL:'http://localhost:8092',OPENCRAWL_IMAGE_TAG:'upgrade-ci'};
function run(command,args,options={}){const r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',stdio:options.capture?'pipe':'inherit',...options,maxBuffer:32*1024*1024});if(!options.failure)assert.equal(r.status,0,`${command} ${args[0]} failed: ${r.stderr||''}`);return options.failure?r:r.stdout?.trim()||'';}
const docker=(args,options)=>run('docker',args,options);
const seedDir=join(scratch,'seed'),fixtureDir=join(scratch,'fixture');mkdirSync(seedDir);mkdirSync(fixtureDir);
copyFileSync(join(root,'dev/seed.mts'),join(fixtureDir,'seed.mts'));
copyFileSync(join(root,'deploy/test-full-large-session.mjs'),join(fixtureDir,'large-upgrade.mjs'));
run('git',['fetch','--depth','1','origin',old]);run('git',['checkout','--detach',old]);
let project='ocdev-0123456789ab',envFile=join(root,'deploy/.env'),override;
if(kind==='deploy'){
 env.COMPOSE_PROJECT_NAME=project;if(sqlite)env.COMPOSE_FILE='compose.yaml:compose.sqlite.yaml';
 run('sh',['deploy/up.sh',...(sqlite?['--sqlite']:[]),'--no-airbyte']);run('sh',['deploy/up.sh','--no-airbyte']);
 const values=parseEnv(readFileSync(envFile,'utf8'));
 writeFileSync(join(seedDir,'seed-input.json'),JSON.stringify({format:1,project,origin:env.OPENCRAWL_URL,connectOrigin:'http://app:8092',organization:values.OPENCRAWL_ORGANIZATION_ID,setupToken:values.OPENCRAWL_SETUP_TOKEN,email:'upgrade@example.com',password:randomBytes(24).toString('hex'),airbyteEnabled:false}),{mode:0o600});
}else{
 delete env.COMPOSE_PROJECT_NAME;delete env.OPENCRAWL_IMAGE_TAG;
 run('bash',['dev/up',...(!airbyte?['--no-airbyte']:[]),...(sqlite?['--sqlite']:[])]);
 const state=JSON.parse(readFileSync('.opencrawl-dev/state.json','utf8'));project=state.project;envFile=join(root,'.opencrawl-dev/compose.env');override=join(root,'.opencrawl-dev/compose.json');
 copyFileSync('.opencrawl-dev/seed/seed-input.json',join(seedDir,'seed-input.json'));
}
function compose(args,options){return docker(['compose','--project-name',project,'--env-file',envFile,'-f',join(root,'deploy/compose.yaml'),...(sqlite?['-f',join(root,'deploy/compose.sqlite.yaml')]:[]),...(override?['-f',override]:[]),...args],options);}
const verify=(readOnly=false)=>{
 const fixture=airbyte?compose(['ps','-q','fixture'],{capture:true}):'';
 const actual=fixture?JSON.parse(docker(['inspect',fixture],{capture:true}))[0].NetworkSettings.Networks[project+'_default'].IPAddress:null;
 return compose(['run','--rm','--no-deps','--user','root','-e','OPENCRAWL_UPGRADE_FIXTURE=true',...(airbyte?['-e','OPENCRAWL_UPGRADE_FRESH_SYNC=true','-e','OPENCRAWL_UPGRADE_FIXTURE_ACTUAL_URL=http://'+actual+':8080']:[]),...(readOnly&&!airbyte?['-e','OPENCRAWL_DEV_VERIFY_ONLY=true']:[]),'--volume',fixtureDir+':/opencrawl/dev:ro','--volume',seedDir+':/dev-state','app','node','--disable-warning=ExperimentalWarning','dev/seed.mts'])};
verify();
const largeSession=(phase,recovery)=>{if(!large)return;const args=['run','--rm','--no-deps','--user','root','-e','UPGRADE_LARGE_PHASE='+phase,'--volume',fixtureDir+':/opencrawl/dev:ro','--volume',seedDir+':/dev-state','app','node','dev/large-upgrade.mjs'];if(recovery)docker([...recovery,...args]);else compose(args);};
largeSession('before');
// Keep a reservation without a raw upload and a deletion fence in the old PG
// layout. A migration that copies only accepted session batches would lose them.
const identityFixture=String.raw`
 if(!process.env.OPENCRAWL_DATABASE_URL){console.log(JSON.stringify({legacy:true}));process.exit(0);}
 const {Client}=await import('pg');
 const c=new Client({connectionString:process.env.OPENCRAWL_DATABASE_URL});await c.connect();
 if(process.env.SEED_IDENTITY_FIXTURE==='true'){
  await c.query('BEGIN');
  const {rows}=await c.query("INSERT INTO opencrawl_event_identity_sessions(namespace,source,identity,resource,state,event_count) VALUES('upgrade-test','failed-upload/',$1,'failed-upload/','ready',1) RETURNING id",['f'.repeat(64)]);
  await c.query('INSERT INTO opencrawl_event_identities(session_id,event_hash,content_hash) VALUES($1,$2,$3)',[rows[0].id,Buffer.alloc(32,1),Buffer.alloc(32,2)]);
  await c.query("INSERT INTO opencrawl_event_identity_deletions(namespace,resource) VALUES('upgrade-test','deleted-session/')");await c.query('COMMIT');
 }
 const identity=(await c.query('SELECT database_id FROM opencrawl_event_identity_schema')).rows[0].database_id;
 const reserved=(await c.query("SELECT encode(e.event_hash,'hex') event,encode(e.content_hash,'hex') content FROM opencrawl_event_identities e JOIN opencrawl_event_identity_sessions s ON s.id=e.session_id WHERE s.namespace='upgrade-test'")).rows;
 const deleted=(await c.query("SELECT resource FROM opencrawl_event_identity_deletions WHERE namespace='upgrade-test'")).rows;
 const role=(await c.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
 console.log(JSON.stringify({identity,reserved,deleted,role}));await c.end();
`;
const previousIdentities=JSON.parse(compose(['exec','-T','-e','SEED_IDENTITY_FIXTURE=true','app','node','--input-type=module','-e',identityFixture],{capture:true}));
const checkIdentities=()=>{
 const result=JSON.parse(compose(['exec','-T','app','node','--input-type=module','-e',identityFixture],{capture:true}));
 assert.deepEqual(result.role,{rolsuper:false,rolcreatedb:false,rolcreaterole:false});
 if(!previousIdentities.legacy){assert.equal(result.identity,previousIdentities.identity);assert.deepEqual(result.reserved,previousIdentities.reserved);assert.deepEqual(result.deleted,previousIdentities.deleted);}
};
const originalEnv=readFileSync(envFile),originalInput=readFileSync(join(seedDir,'seed-input.json'));
const originalFixture=readFileSync(join(seedDir,'upgrade-fixture.json'));
const oldApp=compose(['ps','-q','app'],{capture:true});
run('git',['checkout','--detach',target]);
const check=JSON.parse(run(process.execPath,['deploy/upgrade.mjs','--installation',kind,'--check'],{capture:true}).split('\n').at(-1));
assert.equal(check.needed,true);assert.ok(readFileSync(envFile).equals(originalEnv));assert.equal(docker(['inspect','-f','{{.State.Running}}',oldApp],{capture:true}),'true');
// Fail a real migration subprocess after the matched backup and DB transition.
// No production-only failure switch is added to the upgrader.
const realDocker=run('which',['docker'],{capture:true}),bin=join(scratch,'bin');mkdirSync(bin);
writeFileSync(join(bin,'docker'),'#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a.includes("dist/src/sessions/identity-migration.mjs"))process.exit(97);const r=require("node:child_process").spawnSync('+JSON.stringify(realDocker)+',a,{stdio:"inherit"});process.exit(r.status??1);\n',{mode:0o700});
const failed=run(process.execPath,['deploy/upgrade.mjs','--installation',kind],{failure:true,env:{...env,PATH:bin+':'+env.PATH}});assert.notEqual(failed.status,0);
const journalFile=kind==='dev'?'.opencrawl-dev/upgrade.json':'deploy/.upgrade/upgrade.json';
let journal=JSON.parse(readFileSync(journalFile,'utf8'));assert.equal(journal.phase,'database-transferred');
const backup=journal.backup,manifest=readFileSync(join(backup,'manifest.json'));
assert.equal(compose(['ps','--status','running','-q','app','worker'],{capture:true}),'');
// The operator's usual startup command must resume this very backup.
run(kind==='dev'?'bash':'sh',[kind==='dev'?'dev/up':'deploy/up.sh',...(!airbyte?['--no-airbyte']:[])]);
assert.ok(readFileSync(join(backup,'manifest.json')).equals(manifest));
journal=JSON.parse(readFileSync(journalFile,'utf8'));assert.equal(journal.phase,'complete');
assert.ok(readFileSync(join(seedDir,'seed-input.json')).equals(originalInput));verify(true);checkIdentities();largeSession('after');
assert.equal(compose(['ps','--status','running','-q','temporal-db'],{capture:true}).split('\n').filter(Boolean).length,1);
const legacy=docker(['ps','-q','--filter',`label=com.docker.compose.project=${project}`,'--filter','label=com.docker.compose.service=app-db'],{capture:true});assert.equal(legacy,'');
const after=JSON.parse(run(process.execPath,['deploy/upgrade.mjs','--installation',kind,'--check'],{capture:true}).split('\n').at(-1));assert.equal(after.needed,false);
compose(['restart','app','worker']);compose(['up','-d','--wait','--wait-timeout','600','app','worker']);verify(true);largeSession('verify');
// A subsequent release must retain newly accepted events, not recopy a stopped
// pre-migration app-db. The disposable commit has exactly the same source tree.
run('git',['-c','user.name=Upgrade acceptance','-c','user.email=upgrade@example.com','commit','--allow-empty','-m','Disposable next-release upgrade acceptance']);
run(kind==='dev'?'bash':'sh',[kind==='dev'?'dev/up':'deploy/up.sh',...(!airbyte?['--no-airbyte']:[])]);
const nextJournal=JSON.parse(readFileSync(journalFile,'utf8'));assert.equal(nextJournal.phase,'complete');assert.notEqual(nextJournal.target,target);assert.equal(nextJournal.legacyDatabase,null);verify(true);checkIdentities();largeSession('verify');
// Restore the pre-upgrade matched data AND immutable old runtime images.
if(airbyte)docker(['stop',project+'-control-plane']);
compose(['down','--volumes','--remove-orphans']);
const saved=JSON.parse(readFileSync(join(backup,'snapshot.json'),'utf8'));
for(const store of saved.stores){const names=docker(['volume','ls','--format','{{.Name}}'],{capture:true}).split('\n');if(names.includes(store.name))docker(['volume','rm',store.name]);}
for(const config of saved.configurations)rmSync(resolve(root,config.path),{force:true});
run(process.execPath,['deploy/restore.mjs','--backup',backup]);
const recovery=['compose','--project-name',project,'-f',join(backup,'restore-compose.json')];
docker([...recovery,'up','-d','--wait','--wait-timeout','600']);
// A verification sidecar shares the restored app's image, environment and
// volumes, but must not claim the real app's reserved IP address.
const verificationCompose=structuredClone(saved.compose);
if(verificationCompose.services.app.networks)verificationCompose.services.app.networks={default:{}};
const verificationFile=join(scratch,'verification-compose.json');writeFileSync(verificationFile,JSON.stringify(verificationCompose),{mode:0o600});
const recoveryChecks=['compose','--project-name',project,'-f',verificationFile];
writeFileSync(join(seedDir,'upgrade-fixture.json'),originalFixture);
if(airbyte){
 assert.ok(saved.airbyte,'Recovery must retain the original Airbyte network address');
 docker(['start',saved.airbyte.id]);
 const ready=String.raw`
  const {createAirbyteTransport}=await import('./dist/src/integrations/airbyte.mjs');
  const {setTimeout:delay}=await import('node:timers/promises');
  const api=createAirbyteTransport({url:process.env.AIRBYTE_URL,clientId:process.env.AIRBYTE_CLIENT_ID,clientSecret:process.env.AIRBYTE_CLIENT_SECRET});
  for(let i=0;;i++){try{await api.request('GET','/workspaces?limit=1');break;}catch(error){if(i>=59)throw error;await delay(3000);}}
 `;
 docker([...recoveryChecks,'run','--rm','--no-deps','app','node','--input-type=module','-e',ready]);
 const restored=docker([...recovery,'ps','-q','app'],{capture:true});
 assert.equal(docker(['inspect','-f','{{.Image}}',restored],{capture:true}),saved.compose.services.app.image);
}
// Verify the exact saved old images without rebuilding or changing checkout.
// A new Airbyte sync must reach the restored fixture and S3 addresses.
docker([...recoveryChecks,'run','--rm','--no-deps','--user','root','-e','OPENCRAWL_UPGRADE_FIXTURE=true',...(airbyte?['-e','OPENCRAWL_UPGRADE_FRESH_SYNC=true']:['-e','OPENCRAWL_DEV_VERIFY_ONLY=true']),'--volume',fixtureDir+':/opencrawl/dev:ro','--volume',seedDir+':/dev-state','app','node','--disable-warning=ExperimentalWarning','dev/seed.mts']);
largeSession('restored',recoveryChecks);
const report={ok:true,largeSessionCeilingReproducedAndRemoved:large,largeMessageCaptureAndTailSearch:large,from:old,to:target,installation:kind,airbyte,freshAirbyteSyncAfterUpgradeAndRestore:airbyte,search:sqlite?'sqlite':'opensearch',checkReadOnly:true,normalStartupResumed:true,matchedBackupRetained:true,legacyDatabaseStopped:true,oldGrantPreserved:true,eventRetryAndConflict:true,newWrites:true,restart:true,matchedOldVersionRestore:true,subsequentUpgradePreservesNewEvents:true,restrictedDatabaseRole:true,failedReservationAndDeletion:!previousIdentities.legacy,backupManifestSha256:createHash('sha256').update(manifest).digest('hex')};
writeFileSync(join(process.env.RUNNER_TEMP,'full-upgrade-receipt.json'),JSON.stringify(report,null,2));
docker([...recovery,'down','--volumes','--remove-orphans']);
if(airbyte)run('bash',['dev/up','reset','--yes']);
run('git',['checkout','--detach',target]);
rmSync(scratch,{recursive:true,force:true});
rmSync(backup,{recursive:true,force:true});
rmSync(nextJournal.backup,{recursive:true,force:true});
console.log(JSON.stringify(report));
