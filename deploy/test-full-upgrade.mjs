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
const target=process.env.UPGRADE_TARGET,old=process.env.UPGRADE_FROM,kind=process.env.UPGRADE_INSTALLATION||'deploy',sqlite=process.env.UPGRADE_SQLITE==='true';
assert.match(target,/^[a-f0-9]{40}$/);assert.match(old,/^[a-f0-9]{40}$/);
const env={...process.env,OPENCRAWL_AIRBYTE_ENABLED:'false',OPENCRAWL_URL:'http://localhost:8092',OPENCRAWL_IMAGE_TAG:'upgrade-ci'};
function run(command,args,options={}){const r=spawnSync(command,args,{cwd:root,env,encoding:'utf8',stdio:options.capture?'pipe':'inherit',...options,maxBuffer:32*1024*1024});if(!options.failure)assert.equal(r.status,0,`${command} ${args[0]} failed: ${r.stderr||''}`);return options.failure?r:r.stdout?.trim()||'';}
const docker=(args,options)=>run('docker',args,options);
const seedDir=join(scratch,'seed'),fixtureDir=join(scratch,'fixture');mkdirSync(seedDir);mkdirSync(fixtureDir);
copyFileSync(join(root,'dev/seed.mts'),join(fixtureDir,'seed.mts'));
run('git',['fetch','--depth','1','origin',old]);run('git',['checkout','--detach',old]);
let project='ocdev-0123456789ab',envFile=join(root,'deploy/.env'),override;
if(kind==='deploy'){
 env.COMPOSE_PROJECT_NAME=project;if(sqlite)env.COMPOSE_FILE='compose.yaml:compose.sqlite.yaml';
 run('sh',['deploy/up.sh',...(sqlite?['--sqlite']:[]),'--no-airbyte']);run('sh',['deploy/up.sh','--no-airbyte']);
 const values=parseEnv(readFileSync(envFile,'utf8'));
 writeFileSync(join(seedDir,'seed-input.json'),JSON.stringify({format:1,project,origin:env.OPENCRAWL_URL,connectOrigin:'http://app:8092',organization:values.OPENCRAWL_ORGANIZATION_ID,setupToken:values.OPENCRAWL_SETUP_TOKEN,email:'upgrade@example.com',password:randomBytes(24).toString('hex'),airbyteEnabled:false}),{mode:0o600});
}else{
 delete env.COMPOSE_PROJECT_NAME;delete env.OPENCRAWL_IMAGE_TAG;
 run('bash',['dev/up','--no-airbyte',...(sqlite?['--sqlite']:[])]);
 const state=JSON.parse(readFileSync('.opencrawl-dev/state.json','utf8'));project=state.project;envFile=join(root,'.opencrawl-dev/compose.env');override=join(root,'.opencrawl-dev/compose.json');
 copyFileSync('.opencrawl-dev/seed/seed-input.json',join(seedDir,'seed-input.json'));
}
function compose(args,options){return docker(['compose','--project-name',project,'--env-file',envFile,'-f',join(root,'deploy/compose.yaml'),...(sqlite?['-f',join(root,'deploy/compose.sqlite.yaml')]:[]),...(override?['-f',override]:[]),...args],options);}
const verify=(readOnly=false)=>compose(['run','--rm','--no-deps','--user','root','-e','OPENCRAWL_UPGRADE_FIXTURE=true',...(readOnly?['-e','OPENCRAWL_DEV_VERIFY_ONLY=true']:[]),'--volume',fixtureDir+':/opencrawl/dev:ro','--volume',seedDir+':/dev-state','app','node','--disable-warning=ExperimentalWarning','dev/seed.mts']);
verify();
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
run(kind==='dev'?'bash':'sh',[kind==='dev'?'dev/up':'deploy/up.sh','--no-airbyte']);
assert.ok(readFileSync(join(backup,'manifest.json')).equals(manifest));
journal=JSON.parse(readFileSync(journalFile,'utf8'));assert.equal(journal.phase,'complete');
assert.ok(readFileSync(join(seedDir,'seed-input.json')).equals(originalInput));verify(true);
assert.equal(compose(['ps','--status','running','-q','temporal-db'],{capture:true}).split('\n').filter(Boolean).length,1);
const legacy=docker(['ps','-q','--filter',`label=com.docker.compose.project=${project}`,'--filter','label=com.docker.compose.service=app-db'],{capture:true});assert.equal(legacy,'');
const after=JSON.parse(run(process.execPath,['deploy/upgrade.mjs','--installation',kind,'--check'],{capture:true}).split('\n').at(-1));assert.equal(after.needed,false);
compose(['restart','app','worker']);compose(['up','-d','--wait','--wait-timeout','600','app','worker']);verify(true);
// Restore the pre-upgrade matched data AND immutable old runtime images.
compose(['down','--volumes','--remove-orphans']);
const saved=JSON.parse(readFileSync(join(backup,'snapshot.json'),'utf8'));
for(const store of saved.stores){const names=docker(['volume','ls','--format','{{.Name}}'],{capture:true}).split('\n');if(names.includes(store.name))docker(['volume','rm',store.name]);}
for(const config of saved.configurations)rmSync(resolve(root,config.path),{force:true});
run(process.execPath,['deploy/restore.mjs','--backup',backup]);
const recovery=['compose','--project-name',project,'-f',join(backup,'restore-compose.json')];
docker([...recovery,'up','-d','--wait','--wait-timeout','600']);
writeFileSync(join(seedDir,'upgrade-fixture.json'),originalFixture);
// Use the restored container; the current Compose config would replace it.
docker([...recovery,'run','--rm','--no-deps','--user','root','-e','OPENCRAWL_UPGRADE_FIXTURE=true','-e','OPENCRAWL_DEV_VERIFY_ONLY=true','--volume',fixtureDir+':/opencrawl/dev:ro','--volume',seedDir+':/dev-state','app','node','--disable-warning=ExperimentalWarning','dev/seed.mts']);
const report={ok:true,from:old,to:target,installation:kind,search:sqlite?'sqlite':'opensearch',checkReadOnly:true,normalStartupResumed:true,matchedBackupRetained:true,legacyDatabaseStopped:true,oldGrantPreserved:true,eventRetryAndConflict:true,newWrites:true,restart:true,matchedOldVersionRestore:true,backupManifestSha256:createHash('sha256').update(manifest).digest('hex')};
writeFileSync(join(process.env.RUNNER_TEMP,'full-upgrade-receipt.json'),JSON.stringify(report,null,2));
docker([...recovery,'down','--volumes','--remove-orphans']);
rmSync(scratch,{recursive:true,force:true});
rmSync(backup,{recursive:true,force:true});
console.log(JSON.stringify(report));
