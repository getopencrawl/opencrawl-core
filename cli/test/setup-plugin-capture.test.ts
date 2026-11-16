import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,statSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {installCapture,upgradeCaptureHooks,uninstallCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig} from '../src/capture/runtime.ts';
import {startupHooks} from '../src/startup-install.ts';
import {retireLegacySetupHooks,prepareLegacyPluginMigration,activatePluginOwnership} from '../src/setup/legacy-hooks.ts';
import {configDir} from '../src/session.ts';
import {hookRunner} from '../src/hook-runner.ts';

const clients=['claude-code','codex','cursor','antigravity'] as const;
async function fixture(run:(api:string,dir:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),"opencrawl plugin's capture-")),saved={...process.env};
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({schemaVersion:1,data:{principal:{tenantId:'tenant',userId:'user'},capabilities:{harnesses:clients}}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const api='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{Object.assign(process.env,{OPENCRAWL_CONFIG_HOME:join(dir,'config'),OPENCRAWL_API_URL:api,OPENCRAWL_SESSIONS_TOKEN:'fixture-receiver-token',CLAUDE_DESKTOP_CONFIG_DIR:join(dir,'desktop'),CLAUDE_CONFIG_DIR:join(dir,'claude'),CODEX_HOME:join(dir,'codex'),CURSOR_CONFIG_DIR:join(dir,'cursor'),ANTIGRAVITY_HOME:join(dir,'agy')});await run(api,dir);}
 finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);rmSync(dir,{recursive:true,force:true});}
}
const hookFiles=(dir:string)=>[join(dir,'claude','settings.json'),join(dir,'codex','hooks.json'),join(dir,'cursor','hooks.json'),join(dir,'agy','config','hooks.json')];
const scope=(api:string)=>({api,tenantId:'tenant',userId:'user'});

test('plugin collector enrollment never creates global hook, startup, skill or native policy files',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:[...clients],historyHarnesses:['codex'],selectionMode:'replace',hookOwnership:'plugin',command:['pinned-cli']});
 expect(readCaptureConfig()).toMatchObject({hookOwnership:'plugin',harnesses:[...clients],historyHarnesses:['codex'],owner:{tenantId:'tenant',userId:'user'},command:['pinned-cli']});
 const original=readCaptureConfig()!;
 // Even a future global hook revision must not recreate global hooks.
 writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...original,hookMode:'managed'}));await upgradeCaptureHooks();
 for(const file of [...hookFiles(dir),join(dir,'codex','config.toml'),join(captureDir(),'runner.sh'),join(captureDir(),'runner.cmd'),join(configDir(),'startup'),join(dir,'codex','skills','opencrawl')])expect(existsSync(file)).toBe(false);
 // Enrollment does not need to parse another client's unrelated global config.
 mkdirSync(join(dir,'codex'),{recursive:true});writeFileSync(join(dir,'codex','hooks.json'),'unrelated invalid JSON');
 await installCapture(api,{home:dir,harnesses:['codex'],selectionMode:'replace',hookOwnership:'plugin',command:['pinned-cli']});
 expect(readFileSync(join(dir,'codex','hooks.json'),'utf8')).toBe('unrelated invalid JSON');
 await uninstallCapture(dir);expect(readCaptureConfig()?.disabled).toBe(true);expect(readFileSync(join(dir,'codex','hooks.json'),'utf8')).toBe('unrelated invalid JSON');
}));

test('native migration removes exact profile-owned hooks while retaining foreign hooks, trust, identity and queued data',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:[...clients],command:['legacy-cli']});
 startupHooks([...clients],'install',{home:dir,command:['legacy-cli'],requirementsFile:join(dir,'absent-policy')});
 const previous=readCaptureConfig()!,files=hookFiles(dir);
 const codex=JSON.parse(readFileSync(files[1],'utf8'));
 const foreign={type:'command',command:"/bin/sh '/foreign-profile/capture/runner.sh' collect hook --managed --harness codex",statusMessage:'OpenCrawl session capture'};
 codex.hooks.Stop.push({matcher:'keep',hooks:[foreign,{type:'command',command:'other-user-hook'}]});writeFileSync(files[1],JSON.stringify(codex,null,4)+'\n');chmodSync(files[1],0o640);
 const trust=readFileSync(join(dir,'codex','config.toml'),'utf8')+'\n[hooks.test]\ntrusted_hash = "unchanged"\n';writeFileSync(join(dir,'codex','config.toml'),trust);
 writeFileSync(join(captureDir(),'queue','retained.json'),'queued original bytes');writeFileSync(join(captureDir(),'state','retained.json'),'cursor original bytes');
 const command=['new-pinned-cli'];
 await installCapture(api,{home:dir,harnesses:[...clients],selectionMode:'replace',hookOwnership:'plugin',command});
 const migrated=await retireLegacySetupHooks(scope(api),previous,[...clients]);expect(migrated.files).toHaveLength(3);expect(migrated.preserved).toEqual(['codex']);
 expect(readCaptureConfig()).toMatchObject({installationId:previous.installationId,owner:previous.owner,installedAt:previous.installedAt,hookOwnership:'plugin',command});
 expect(readFileSync(files[1],'utf8')).toBe(JSON.stringify(codex,null,4)+'\n');
 for(const file of [files[0],files[2],files[3]])expect(readFileSync(file,'utf8')).not.toContain('runner.');
 expect(readFileSync(join(dir,'codex','config.toml'),'utf8')).toBe(trust);if(process.platform!=='win32')expect(statSync(files[1]).mode&0o777).toBe(0o640);
 expect(readFileSync(join(captureDir(),'queue','retained.json'),'utf8')).toBe('queued original bytes');expect(readFileSync(join(captureDir(),'state','retained.json'),'utf8')).toBe('cursor original bytes');
 const bytes=files.map(file=>readFileSync(file,'utf8')),times=files.map(file=>statSync(file).mtimeMs);
 expect((await retireLegacySetupHooks(scope(api),readCaptureConfig(),[...clients])).files).toEqual([]);expect(files.map(file=>readFileSync(file,'utf8'))).toEqual(bytes);expect(files.map(file=>statSync(file).mtimeMs)).toEqual(times);
}));

test('Antigravity migration preserves foreign entries and native disabled choices',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['antigravity'],command:['legacy-cli']});
 startupHooks(['antigravity'],'install',{home:dir,command:['legacy-cli'],requirementsFile:join(dir,'absent-policy')});
 const previous=readCaptureConfig()!,file=hookFiles(dir)[3],before=JSON.parse(readFileSync(file,'utf8'));
 before['opencrawl-capture'].Stop.push({type:'command',command:"/bin/sh '/another/capture/runner.sh' collect hook --harness antigravity"});
 before['opencrawl-startup'].enabled=false;writeFileSync(file,JSON.stringify(before));
 await installCapture(api,{home:dir,harnesses:['antigravity'],selectionMode:'replace',hookOwnership:'plugin',command:['new-cli']});
 await retireLegacySetupHooks(scope(api),previous,['antigravity']);const after=JSON.parse(readFileSync(file,'utf8'));
 expect(after['opencrawl-capture'].Stop).toEqual([before['opencrawl-capture'].Stop[1]]);expect(after['opencrawl-capture'].SessionStart).toEqual([]);expect(after['opencrawl-startup']).toEqual(before['opencrawl-startup']);
}));

test('native migration validates every affected file before writing and refuses a foreign destination',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['claude-code','codex'],command:['legacy-cli']});const previous=readCaptureConfig()!,files=hookFiles(dir);
 await installCapture(api,{home:dir,harnesses:['claude-code','codex'],selectionMode:'replace',hookOwnership:'plugin',command:['new-cli']});
 const before=readFileSync(files[0],'utf8');writeFileSync(files[1],'{invalid');
 await expect(retireLegacySetupHooks(scope(api),previous,['claude-code','codex'])).rejects.toMatchObject({code:'PLUGIN_HOOK_MIGRATION_INVALID'});expect(readFileSync(files[0],'utf8')).toBe(before);
 expect(await retireLegacySetupHooks({...scope(api),api:'https://foreign.example'},previous,['claude-code'])).toEqual({files:[],preserved:[]});expect(readFileSync(files[0],'utf8')).toBe(before);
}));

test('Codex migration can remove owned hooks when no foreign native trust key moves',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['legacy-cli']});const previous=readCaptureConfig()!,file=hookFiles(dir)[1];
 await installCapture(api,{home:dir,harnesses:['codex'],selectionMode:'replace',hookOwnership:'plugin',command:['new-cli']});
 const result=await retireLegacySetupHooks(scope(api),previous,['codex']);expect(result).toEqual({files:[file],preserved:[]});expect(JSON.parse(readFileSync(file,'utf8')).hooks).toEqual({});
}));

test('legacy handover refreshes only verified profile runners and preserves global definitions',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['old-cli']});startupHooks(['codex'],'install',{home:dir,command:['old-cli'],requirementsFile:join(dir,'absent-policy')});
 const before=readCaptureConfig()!,hooks=readFileSync(hookFiles(dir)[1],'utf8'),command=['new-guarded-cli'];
 const migration=prepareLegacyPluginMigration(scope(api),before,command);expect(readCaptureConfig()?.hookOwnership).toBe('global');
 await activatePluginOwnership(scope(api),migration);expect(readCaptureConfig()).toMatchObject({hookOwnership:'plugin',installationId:before.installationId,owner:before.owner});
 for(const area of ['capture','startup']){const runner=hookRunner(area,command);expect(readFileSync(runner.file,'utf8')).toBe(runner.script);}
 expect(readFileSync(hookFiles(dir)[1],'utf8')).toBe(hooks);
}));

test('unknown or concurrently changed legacy runners preserve existing ownership and recording',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['old-cli']});const before=readFileSync(join(captureDir(),'config.json'),'utf8'),runner=hookRunner('capture',['old-cli']);
 writeFileSync(runner.file,'custom existing runner');expect(()=>prepareLegacyPluginMigration(scope(api),readCaptureConfig(),['new-cli'])).toThrow('does not match');expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(readFileSync(runner.file,'utf8')).toBe('custom existing runner');
 runner.write();const migration=prepareLegacyPluginMigration(scope(api),readCaptureConfig(),['new-cli']);writeFileSync(runner.file,'concurrent change');
 await expect(activatePluginOwnership(scope(api),migration)).rejects.toMatchObject({code:'PLUGIN_HOOK_MIGRATION_INVALID'});expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);expect(readFileSync(runner.file,'utf8')).toBe('concurrent change');
}));

test('setup enrollment rejects a concurrent local collector change before replacing its binding or queue',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['old-cli']});const expectedConfig=readCaptureConfig()!;
 const file=join(captureDir(),'config.json'),changed={...expectedConfig,installationId:'concurrently-installed',owner:{tenantId:'other-tenant',userId:'other-user'}};writeFileSync(file,JSON.stringify(changed));writeFileSync(join(captureDir(),'queue','concurrent.json'),'other collector queue');const before=readFileSync(file,'utf8');
 await expect(installCapture(api,{home:dir,harnesses:[],selectionMode:'replace',hookOwnership:'plugin',deferPluginOwnership:true,expectedOwner:scope(api),expectedConfig,command:['new-cli']})).rejects.toMatchObject({code:'CAPTURE_CONFIG_CHANGED'});
 expect(readFileSync(file,'utf8')).toBe(before);expect(readFileSync(join(captureDir(),'queue','concurrent.json'),'utf8')).toBe('other collector queue');
}));

test('migration preserves wrapper commands that merely mention an owned runner',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['cursor'],command:['legacy-cli']});const previous=readCaptureConfig()!,file=hookFiles(dir)[2],config=JSON.parse(readFileSync(file,'utf8'));
 const wrapper={command:'echo '+config.hooks.stop[0].command,timeout:30};config.hooks.stop.push(wrapper);writeFileSync(file,JSON.stringify(config));
 await installCapture(api,{home:dir,harnesses:['cursor'],selectionMode:'replace',hookOwnership:'plugin',command:['new-cli']});await retireLegacySetupHooks(scope(api),previous,['cursor']);
 expect(JSON.parse(readFileSync(file,'utf8')).hooks).toEqual({stop:[wrapper]});
}));

test.skipIf(process.platform==='win32')('a partial runner write failure rolls back verified runners and ownership',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['old-cli']});startupHooks(['codex'],'install',{home:dir,command:['old-cli'],requirementsFile:join(dir,'absent-policy')});
 const before=readFileSync(join(captureDir(),'config.json'),'utf8'),migration=prepareLegacyPluginMigration(scope(api),readCaptureConfig(),['new-cli']),startup=join(configDir(),'startup');
 chmodSync(startup,0o500);
 try{await expect(activatePluginOwnership(scope(api),migration)).rejects.toThrow();}
 finally{chmodSync(startup,0o700);}
 expect(readFileSync(join(captureDir(),'config.json'),'utf8')).toBe(before);
 for(const area of ['capture','startup']){const runner=hookRunner(area,['old-cli']);expect(readFileSync(runner.file,'utf8')).toBe(runner.script);}
}));

test('unused legacy runner files do not block migration but active unknown commands do',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['old-cli']});const previous=readCaptureConfig()!,file=join(captureDir(),'runner.cjs');writeFileSync(file,'retained historical runner');
 expect(prepareLegacyPluginMigration(scope(api),previous,['new-cli'])).not.toBeNull();
 const hooks=hookFiles(dir)[1],before=JSON.parse(readFileSync(hooks,'utf8'));before.hooks.Stop.push({hooks:[{type:'command',command:'node '+file+' collect hook --harness codex',statusMessage:'OpenCrawl session capture'}]});writeFileSync(hooks,JSON.stringify(before));
 expect(()=>prepareLegacyPluginMigration(scope(api),previous,['new-cli'])).toThrow('older runner');expect(readFileSync(file,'utf8')).toBe('retained historical runner');expect(readCaptureConfig()?.hookOwnership).toBe('global');
}));


test('native migration removes only exact profile-bound search context hooks',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['claude-code'],command:['legacy-cli']});
 startupHooks(['claude-code'],'install',{home:dir,command:['legacy-cli'],requirementsFile:join(dir,'absent-policy')});
 const previous=readCaptureConfig()!,file=hookFiles(dir)[0],before=JSON.parse(readFileSync(file,'utf8'));
 const group=before.hooks.PreToolUse.find((entry:{hooks:{command:string}[]})=>entry.hooks.some(hook=>hook.command.includes(' search-context ')));
 const owned=group.hooks[0];
 expect(owned.command).toContain('search-context --harness claude-code');
 const foreign={...owned,command:owned.command.replace(/startup([\\/])runner\./,'different-profile$1runner.')};
 const wrapper={...owned,command:'echo '+owned.command};
 group.hooks.push(foreign,wrapper);writeFileSync(file,JSON.stringify(before));
 await installCapture(api,{home:dir,harnesses:['claude-code'],selectionMode:'replace',hookOwnership:'plugin',command:['new-cli']});
 await retireLegacySetupHooks(scope(api),previous,['claude-code']);
 const after=JSON.parse(readFileSync(file,'utf8'));
 expect(after.hooks.PreToolUse).toEqual([{...group,hooks:[foreign,wrapper]}]);
}));
