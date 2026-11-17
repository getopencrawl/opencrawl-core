import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {installCapture,upgradeCaptureHooks,uninstallCapture} from '../src/capture/install.ts';
import {captureDir,readCaptureConfig} from '../src/capture/runtime.ts';
import {configDir} from '../src/session.ts';

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

test('setup enrollment rejects a concurrent local collector change before replacing its binding or queue',()=>fixture(async(api,dir)=>{
 await installCapture(api,{home:dir,harnesses:['codex'],command:['old-cli']});const expectedConfig=readCaptureConfig()!;
 const file=join(captureDir(),'config.json'),changed={...expectedConfig,installationId:'concurrently-installed',owner:{tenantId:'other-tenant',userId:'other-user'}};writeFileSync(file,JSON.stringify(changed));writeFileSync(join(captureDir(),'queue','concurrent.json'),'other collector queue');const before=readFileSync(file,'utf8');
 await expect(installCapture(api,{home:dir,harnesses:[],selectionMode:'replace',hookOwnership:'plugin',expectedOwner:scope(api),expectedConfig,command:['new-cli']})).rejects.toMatchObject({code:'CAPTURE_CONFIG_CHANGED'});
 expect(readFileSync(file,'utf8')).toBe(before);expect(readFileSync(join(captureDir(),'queue','concurrent.json'),'utf8')).toBe('other collector queue');
}));
