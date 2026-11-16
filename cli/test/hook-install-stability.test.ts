import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, utimesSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installCapture, upgradeCaptureHooks} from '../src/capture/install.ts';
import {collectCommand} from '../src/capture/command.ts';
import {captureDir, readCaptureConfig, HOOK_MODE} from '../src/capture/runtime.ts';
import {startupHooks, startupMarker} from '../src/startup-install.ts';
import {hookRunner} from '../src/hook-runner.ts';

const clients = ['claude-code', 'codex', 'cursor'] as const;
const marker = 'OpenCrawl session capture';
const api = 'http://127.0.0.1:1'; // Deferred auth and skipped history make no requests.
async function fixture(run: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'opencrawl-hook-order-')), saved = {...process.env};
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('OPENCRAWL_')) delete process.env[key];
    Object.assign(process.env, {HOME:home, USERPROFILE:home, OPENCRAWL_CONFIG_HOME:join(home,'config'),
      CLAUDE_CONFIG_DIR:join(home,'.claude'), CODEX_HOME:join(home,'.codex'), CURSOR_CONFIG_DIR:join(home,'.cursor'), ANTIGRAVITY_HOME:join(home,'.gemini')});
    await run(home);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(home, {recursive:true, force:true});
  }
}
const files = (home: string) => ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json'].map(file => join(home,file));
const options = (home: string) => ({home, env:process.env, requirementsFile:join(home,'no-system-policy.toml')});
const snapshot = (paths: string[]) => paths.map(file => ({text:readFileSync(file,'utf8'), mtime:statSync(file).mtimeMs, mode:statSync(file).mode & 0o777}));
function freezeMetadata(paths: string[]) {
  for (const file of paths) {
    // A harmless formatting change must not cause an installer rewrite.
    writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file,'utf8')),null,4)+'\n\n');
    chmodSync(file, 0o640);
    utimesSync(file, new Date(1700000000000), new Date(1700000000000));
  }
}
for (const startupFirst of [false, true]) test(`adding Antigravity and repeating setup preserve existing hook files (startup first: ${startupFirst})`, () => fixture(async home => {
  for (const file of files(home)) {
    mkdirSync(join(file,'..'), {recursive:true});
    writeFileSync(file, JSON.stringify({custom:'preserve settings',hooks:{UnrelatedEmptyEvent:[]}},null,4)+'\n');
  }
  if (startupFirst) expect(startupHooks([...clients],'install',options(home)).every(row=>row.status==='installed')).toBe(true);
  await installCapture(api, {home,deferAuth:true,harnesses:[...clients]});
  if (!startupFirst) expect(startupHooks([...clients],'install',options(home)).every(row=>row.status==='installed')).toBe(true);
  freezeMetadata(files(home));
  const before = snapshot(files(home));
  const result = await collectCommand('install',api,{harness:'antigravity',yes:true,backfill:'skip','defer-auth':true,json:true});
  expect(result).toMatchObject({harnesses:[...clients,'antigravity'],backfill:{status:'skipped'}});
  expect(JSON.parse(readFileSync(join(home,'.gemini/config/hooks.json'),'utf8'))).toHaveProperty('opencrawl-capture');
  expect(snapshot(files(home))).toEqual(before);
  for (let attempt=0; attempt<2; attempt++) {
    expect(startupHooks([...clients],'status',options(home)).map(row=>row.status)).toEqual(['current','current','current']);
    expect(startupHooks([...clients],'install',options(home)).map(row=>row.status)).toEqual(['unchanged','unchanged','unchanged']);
    await installCapture(api,{home,deferAuth:true,harnesses:[...clients]});
    expect(snapshot(files(home))).toEqual(before);
  }
  // Updating the actual launcher must update both runners without invalidating
  // native trust for the unchanged hook definitions that invoke those runners.
  const command = [join(home,'replacement-cli'), 'fixture-argument'];
  await installCapture(api,{home,deferAuth:true,harnesses:[...clients],command});
  expect(startupHooks([...clients],'install',{...options(home),command}).every(row=>['installed','unchanged'].includes(row.status))).toBe(true);
  for (const area of ['startup','capture']) expect(readFileSync(hookRunner(area,command).file,'utf8')).toBe(hookRunner(area,command).script);
  expect(snapshot(files(home))).toEqual(before);
  expect(startupHooks([...clients],'status',{...options(home),command}).every(row=>row.status==='current')).toBe(true);
  // Explicitly opting out removes capture while keeping startup and settings.
  await installCapture(api,{home,deferAuth:true,harnesses:[],selectionMode:'replace',command});
  expect(readCaptureConfig()?.harnesses).toEqual([]);
  for (const file of files(home)) {
    const text=readFileSync(file,'utf8');
    expect(text).not.toContain(' collect hook ');
    expect(text).toContain(' session start --harness ');
    expect(text).toContain('preserve settings');
    expect(statSync(file).mode & 0o777).toBe(before[0]!.mode);
  }
  expect(startupHooks([...clients],'status',{...options(home),command}).every(row=>row.status==='current')).toBe(true);
}));

type Hook = {type:string;command:string;timeout:number;statusMessage?:string;async?:boolean};
type Group = {hooks:Hook[];matcher?:string;metadata?:string};
type Config = {custom:string;hooks:Record<string,Group[]>};
test('real hook migrations remove duplicates and conditional ownership without moving unrelated hooks', () => fixture(async home => {
  await installCapture(api,{home,deferAuth:true,harnesses:['codex']});
  startupHooks(['codex'],'install',options(home));
  const file=join(home,'.codex/hooks.json'), original=JSON.parse(readFileSync(file,'utf8')) as Config;
  const capture=original.hooks.SessionStart![0]!.hooks[0]!, startup=original.hooks.SessionStart![1]!.hooks[0]!;
  const user:Hook={type:'command',command:'user-hook',timeout:4};
  const staleCapture={...capture,command:'old-capture-command',timeout:1,async:false};
  const staleStartup={...startup,command:'old-startup-command',timeout:1};
  original.custom='preserve settings';
  original.hooks.SessionStart=[
    {metadata:'shared group',hooks:[user,staleCapture,staleStartup]},
    {matcher:'Edit',metadata:'conditional group',hooks:[user,{...staleCapture}]},
    {hooks:[{...staleCapture},{...staleStartup}]},
  ];
  original.hooks.ObsoleteEvent=[{metadata:'keep obsolete event user hook',hooks:[user,{...staleCapture},{...staleStartup}]}];
  writeFileSync(file,JSON.stringify(original,null,4)+'\n');chmodSync(file,0o640);
  const mode=statSync(file).mode & 0o777;
  const config=readCaptureConfig()!;
  writeFileSync(join(captureDir(),'config.json'),JSON.stringify({...config,hookMode:'legacy-fixture'}));
  await upgradeCaptureHooks();
  expect(readCaptureConfig()?.hookMode).toBe(HOOK_MODE);
  expect(startupHooks(['codex'],'install',options(home))[0]?.status).toBe('installed');
  const migrated=JSON.parse(readFileSync(file,'utf8')) as Config;
  expect(migrated.custom).toBe('preserve settings');
  expect(migrated.hooks.SessionStart).toEqual([
    {metadata:'shared group',hooks:[user,capture,startup]},
    {matcher:'Edit',metadata:'conditional group',hooks:[user]},
  ]);
  expect(migrated.hooks.ObsoleteEvent).toEqual([{metadata:'keep obsolete event user hook',hooks:[user]}]);
  expect(statSync(file).mode & 0o777).toBe(mode);
  // A conditional-only entry is insufficient for an unconditional installer.
  migrated.hooks.SessionStart=[{matcher:'Edit',metadata:'retain scope',hooks:[user,capture,startup]}];
  writeFileSync(file,JSON.stringify(migrated));
  await installCapture(api,{home,deferAuth:true,harnesses:['codex']});
  startupHooks(['codex'],'install',options(home));
  const unconditional=JSON.parse(readFileSync(file,'utf8')) as Config;
  expect(unconditional.hooks.SessionStart).toEqual([
    {matcher:'Edit',metadata:'retain scope',hooks:[user]}, {hooks:[capture]}, {hooks:[startup]},
  ]);
  expect(startupHooks(['codex'],'status',options(home))[0]?.status).toBe('current');
  expect(unconditional.hooks.SessionStart!.flatMap(group=>group.hooks).filter(hook=>[marker,startupMarker].includes(hook.statusMessage??''))).toHaveLength(2);
}));

test('malformed grouped hooks fail without leaving partial capture changes', () => fixture(async home => {
  await installCapture(api,{home,deferAuth:true,harnesses:[...clients]});
  startupHooks([...clients],'install',options(home));
  const codex=join(home,'.codex/hooks.json');
  for (const groups of [null, [null], [{hooks:[null]}]]) {
    writeFileSync(codex,JSON.stringify({hooks:{Stop:groups}}));
    const paths=[...files(home),join(captureDir(),'config.json'),hookRunner('capture',[]).file];
    const before=paths.map(file=>({bytes:readFileSync(file),mode:statSync(file).mode & 0o777}));
    await expect(installCapture(api,{home,deferAuth:true,harnesses:[...clients],command:['changed-runner']})).rejects.toMatchObject({code:'CAPTURE_INVALID_CONFIG'});
    expect(paths.map(file=>({bytes:readFileSync(file),mode:statSync(file).mode & 0o777}))).toEqual(before);
  }
}));
