import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const source=resolve(import.meta.dir,'../src');
async function fixture(run:(home:string, invoke:(args:string[],options?:{noUpdate?:boolean;busy?:boolean;profile?:string})=>Promise<any>)=>Promise<void>) {
  const home=mkdtempSync(join(tmpdir(),'opencrawl-activation-'));
  const runner=join(home,'run.ts');
  writeFileSync(runner,`
    globalThis.OPENCRAWL_VERSION='0.4.64';
    let requests=0;globalThis.fetch=async()=>{requests++;throw new Error('network forbidden');};
    const {main}=await import(${JSON.stringify(join(source,'cli.ts'))});
    const invoke=async()=>{const code=await main(JSON.parse(process.env.TEST_ARGS));process.stderr.write(JSON.stringify({code,requests}));};
    if(process.env.TEST_BUSY==='1') {
      const {withSessionLock}=await import(${JSON.stringify(join(source,'session.ts'))});
      await withSessionLock('skills:installation',invoke);
    } else await invoke();
  `);
  const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,PATH:'',XDG_CACHE_HOME:join(home,'cache'),XDG_DATA_HOME:join(home,'data'),
    OPENCRAWL_CONFIG_HOME:join(home,'config'),CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),
    CURSOR_CONFIG_DIR:join(home,'.cursor'),ANTIGRAVITY_HOME:join(home,'.gemini'),OPENCRAWL_API_URL:'https://activation.invalid'};
  delete env.OPENCRAWL_TOKEN;delete env.OPENCRAWL_NO_UPDATE;delete env.CLAUDE_CODE_REMOTE;
  const invoke=async(args:string[],{noUpdate=false,busy=false,profile='config'}={})=>{
    const proc=Bun.spawn([process.execPath,runner],{env:{...env,OPENCRAWL_CONFIG_HOME:join(home,profile),TEST_ARGS:JSON.stringify(args),TEST_BUSY:busy?'1':'0',...(noUpdate?{OPENCRAWL_NO_UPDATE:'1'}:{})},
      stdin:new Blob([JSON.stringify({hook_event_name:'SessionStart',session_id:'native-test'})]),stdout:'pipe',stderr:'pipe'});
    const [out,err,exit]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);
    expect(exit).toBe(0);expect(JSON.parse(err)).toEqual({code:0,requests:0});
    return out?JSON.parse(out):undefined;
  };
  try{await run(home,invoke);}finally{rmSync(home,{recursive:true,force:true});}
}

const clients=[
  {name:'codex',skill:'.agents/skills/opencrawl',hooks:'.codex/hooks.json'},
  {name:'claude-code',skill:'.claude/skills/opencrawl',hooks:'.claude/settings.json'},
  {name:'cursor',skill:'.cursor/skills/opencrawl',hooks:'.cursor/hooks.json'},
  {name:'antigravity',skill:'.gemini/config/skills/opencrawl',hooks:'.gemini/config/hooks.json'},
];
function oldInstallation(home:string,selected=clients) {
  for(const client of selected) {
    mkdirSync(join(home,client.hooks,'..'),{recursive:true});
    mkdirSync(join(home,client.skill),{recursive:true});
    writeFileSync(join(home,client.skill,'SKILL.md'),'previous installed guidance');
    writeFileSync(join(home,client.skill,'.opencrawl-skill.json'),JSON.stringify({schemaVersion:2,revision:8,files:{'SKILL.md':'old'}}));
  }
  mkdirSync(join(home,'cache','opencrawl'),{recursive:true});
  writeFileSync(join(home,'cache','opencrawl','skills-update.json'),JSON.stringify({version:'0.4.63',revision:8,complete:true}));
}

test('a capture-only invocation activates prior skills and exact native hooks once, without network',()=>fixture(async(home,invoke)=>{
  oldInstallation(home);
  await invoke(['collect','hook','--harness','claude-code']);
  for(const client of clients) {
    expect(JSON.parse(readFileSync(join(home,client.skill,'.opencrawl-skill.json'),'utf8')).revision).toBe(10);
    expect(readFileSync(join(home,client.skill,'SKILL.md'),'utf8')).toContain('Native hooks target only opencrawl_search');
    expect(readFileSync(join(home,client.hooks),'utf8')).toContain('search-context --harness '+client.name);
  }
  const paths=clients.flatMap(client=>[join(home,client.hooks),join(home,client.skill,'SKILL.md')]);
  paths.push(join(home,'config','opencrawl','skills-update.json'),join(home,'cache','opencrawl','skills-update.json'));
  const before=paths.map(file=>({text:readFileSync(file,'utf8'),mtime:statSync(file).mtimeMs}));
  await invoke(['collect','hook','--harness','claude-code']);
  expect(paths.map(file=>({text:readFileSync(file,'utf8'),mtime:statSync(file).mtimeMs}))).toEqual(before);
}));

test('new-session activation requests Claude skill rediscovery and does not wait for a busy installer',()=>fixture(async(home,invoke)=>{
  oldInstallation(home,[clients[1]!]);
  const start=['session','start','--harness','claude-code'];
  const then=Date.now();await invoke(start,{busy:true});
  expect(Date.now()-then).toBeLessThan(3000);
  expect(JSON.parse(readFileSync(join(home,clients[1]!.skill,'.opencrawl-skill.json'),'utf8')).revision).toBe(8);
  const result=await invoke(start);
  expect(result.hookSpecificOutput.reloadSkills).toBe(true);
  expect(JSON.parse(readFileSync(join(home,clients[1]!.skill,'.opencrawl-skill.json'),'utf8')).revision).toBe(10);
}));

test('activation honors opt-out, disabled hooks and first-install boundary; per-search hook stays pure',()=>fixture(async(home,invoke)=>{
  oldInstallation(home,[clients[1]!]);
  await invoke(['collect','hook','--harness','claude-code'],{noUpdate:true});
  expect(readFileSync(join(home,clients[1]!.skill,'SKILL.md'),'utf8')).toBe('previous installed guidance');
  await invoke(['search-context','--harness','claude-code']);
  expect(readFileSync(join(home,clients[1]!.skill,'SKILL.md'),'utf8')).toBe('previous installed guidance');
  writeFileSync(join(home,clients[1]!.hooks),JSON.stringify({disableAllHooks:true}));
  mkdirSync(join(home,'.codex'));
  await invoke(['collect','hook','--harness','claude-code']);
  expect(JSON.parse(readFileSync(join(home,clients[1]!.hooks),'utf8'))).toEqual({disableAllHooks:true});
  expect(existsSync(join(home,'.agents/skills/opencrawl'))).toBe(false);
  expect(existsSync(join(home,'.codex/hooks.json'))).toBe(false);
}));


test('each existing OpenCrawl profile activates its own hooks after another profile refreshes shared skills',()=>fixture(async(home,invoke)=>{
  await invoke(['skills','install','--client','claude-code','--json'],{profile:'other-profile'});
  const hooks=join(home,clients[1]!.hooks),config=JSON.parse(readFileSync(hooks,'utf8'));
  delete config.hooks.PreToolUse;
  writeFileSync(hooks,JSON.stringify(config));
  oldInstallation(home,[clients[1]!]);
  const before=readFileSync(hooks,'utf8');
  await invoke(['collect','hook','--harness','claude-code']);
  expect(readFileSync(hooks,'utf8')).toBe(before);
  await invoke(['collect','hook','--harness','claude-code'],{profile:'other-profile'});
  expect(readFileSync(hooks,'utf8')).toContain('search-context --harness claude-code');
  expect(readFileSync(hooks,'utf8')).toContain('other-profile');
  for(const profile of ['config','other-profile'])expect(JSON.parse(readFileSync(join(home,profile,'opencrawl','skills-update.json'),'utf8')).complete).toBe(true);
  expect(JSON.parse(readFileSync(join(home,'cache','opencrawl','skills-update.json'),'utf8')).revision).toBe(8);
}));

test('already-refreshed skills create a current profile receipt with zero changes and no file churn',()=>fixture(async(home,invoke)=>{
  const selected=[clients[0]!,clients[1]!];
  oldInstallation(home,selected);
  const refreshed=await invoke(['skills','refresh','--json']);
  expect(refreshed.data.results.filter((row:any)=>row.status==='updated')).toHaveLength(2);
  // The legacy launcher has its own global receipt; the native profile still
  // verifies the installed integration and records its own zero-change outcome.
  const legacy=join(home,'cache','opencrawl','skills-update.json');
  writeFileSync(legacy,JSON.stringify({version:'0.4.64',complete:true,result:{status:'current',updated:2,conflicts:0,errors:0}}));
  const paths=selected.flatMap(client=>[join(home,client.hooks),join(home,client.skill,'SKILL.md'),join(home,client.skill,'.opencrawl-skill.json')]);
  paths.push(legacy,join(home,'config','opencrawl','startup',process.platform==='win32'?'runner.cmd':'runner.sh'));
  const snapshot=()=>paths.map(file=>({text:readFileSync(file,'utf8'),mtime:statSync(file).mtimeMs}));
  const before=snapshot(),receipt=join(home,'config','opencrawl','skills-update.json');
  expect(existsSync(receipt)).toBe(false);
  await invoke(['collect','hook','--harness','claude-code']);
  expect(JSON.parse(readFileSync(receipt,'utf8'))).toMatchObject({version:'0.4.64',revision:10,complete:true,
    result:{status:'current',updated:0,conflicts:0,errors:0}});
  expect(snapshot()).toEqual(before);
}));
