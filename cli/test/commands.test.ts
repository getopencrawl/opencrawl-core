import {test, expect} from 'bun:test';
import {resolve, join} from 'node:path';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';

test('agent command errors keep stdout JSON, stable exit codes and credential-free messages', () => {
  const directory = mkdtempSync(join(tmpdir(), 'opencrawl-commands-'));
  try {
    for (const args of [
      ['unknown'], ['status', '--unknown'], ['whoami', 'extra'],
      ['whoami', '--api', 'http://remote.example'],
      ['whoami', '--api', 'https://secret-user:secret-password@example.com'],
      ['whoami', '--api', ''], ['update', '--unknown'],
    ]) {
      const result = Bun.spawnSync(['bun', resolve(import.meta.dir, '../src/cli.ts'), ...args, '--json'], {env: {...process.env, OPENCRAWL_CONFIG_HOME: directory}, stdout: 'pipe', stderr: 'pipe'});
      expect(result.exitCode).toBe(64);
      const output = result.stdout.toString();
      expect(JSON.parse(output)).toMatchObject({schemaVersion: 1, error: {code: 'INVALID_USAGE'}});
      expect(output).not.toContain('secret');
      expect(result.stderr.toString()).toBe('');
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});


test('identity distinguishes organization setup, email verification and denied access', async () => {
  const {identity}=await import('../src/cli.ts');
  for(const [code,message] of [
    ['ORGANIZATION_REQUIRED','Open https://capture.example.com/organizations in your browser to create or join a team'],
    ['EMAIL_VERIFICATION_REQUIRED','Verify your email address'],
    ['UNKNOWN','This account cannot access the deployment'],
  ]) {
    const fetcher=(async()=>Response.json({schemaVersion:1,error:{code}},{status:403})) as unknown as typeof fetch;
    await expect(identity('https://capture.example.com',fetcher,'fixture-token')).rejects.toThrow(message);
  }
});

test('CLI cloud preparation needs only the upload token and preserves explicit server overrides',()=>{
  const directory=mkdtempSync(join(tmpdir(),'opencrawl-cloud-cli-'));
  try{
    for(const [name,envApi,args,expected] of [
      ['default',undefined,[],'https://app.getopencrawl.com'],
      ['environment','https://self.example',[],'https://self.example'],
      ['flag','https://self.example',['--api','https://selected.example/'],'https://selected.example'],
    ] as const){
      const home=join(directory,name),config=join(home,'config');
      const env:NodeJS.ProcessEnv={...process.env,HOME:home,USERPROFILE:home,OPENCRAWL_CONFIG_HOME:config,CLAUDE_CONFIG_DIR:join(home,'claude'),CODEX_HOME:join(home,'codex'),OPENCRAWL_SESSIONS_TOKEN:'fixture-only-secret',OPENCRAWL_NO_UPDATE:'1'};
      delete env.OPENCRAWL_TOKEN;delete env.OPENCRAWL_API_URL;
      if(envApi)env.OPENCRAWL_API_URL=envApi;
      const command=['bun',resolve(import.meta.dir,'../src/cli.ts'),'collect','install','--yes','--defer-auth','--backfill','skip','--harness','claude-code',...args,'--json'];
      // Repeated setup also exercises selection of the saved cloud destination.
      for(let attempt=0;attempt<2;attempt++){
        const result=Bun.spawnSync(command,{env,stdout:'pipe',stderr:'pipe'});
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).not.toContain('fixture-only-secret');
        expect(JSON.parse(readFileSync(join(config,'opencrawl','capture','config.json'),'utf8'))).toMatchObject({api:expected,authPending:true});
      }
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('CLI does not redirect a cloud environment token to a saved self-hosted destination',()=>{
  const directory=mkdtempSync(join(tmpdir(),'opencrawl-token-cli-'));
  try{
    const env:NodeJS.ProcessEnv={...process.env,OPENCRAWL_CONFIG_HOME:directory,OPENCRAWL_TOKEN:'fixture-only-secret'};
    delete env.OPENCRAWL_API_URL;
    delete env.OPENCRAWL_SESSIONS_TOKEN;
    mkdirSync(join(directory,'opencrawl','capture'),{recursive:true});
    writeFileSync(join(directory,'opencrawl','capture','config.json'),JSON.stringify({api:'https://self.example',disabled:true}));
    const result=Bun.spawnSync(['bun',resolve(import.meta.dir,'../src/cli.ts'),'search','fixture','--json'],{env,stdout:'pipe',stderr:'pipe'});
    expect(result.exitCode).toBe(64);
    const output=result.stdout.toString();
    expect(JSON.parse(output)).toMatchObject({error:{code:'TOKEN_DESTINATION_MISMATCH'}});
    expect(output).not.toContain('fixture-only-secret');
  }finally{rmSync(directory,{recursive:true,force:true});}
});


test.each(['claude-code','codex','cursor','agy','grok-bot'])('explicit %s capture install scopes skills and startup hooks to that client',harness=>{
  const directory=mkdtempSync(join(tmpdir(),'opencrawl-selected-client-'));
  try{
    const roots={
      'claude-code':join(directory,'.claude'),codex:join(directory,'.codex'),
      cursor:join(directory,'.cursor'),antigravity:join(directory,'.gemini'),
    };
    const files={
      'claude-code':join(roots['claude-code'],'settings.json'),codex:join(roots.codex,'hooks.json'),
      cursor:join(roots.cursor,'hooks.json'),antigravity:join(roots.antigravity,'config','hooks.json'),
    };
    for(const [client,file] of Object.entries(files)){
      mkdirSync(resolve(file,'..'),{recursive:true});
      writeFileSync(file,JSON.stringify(client==='antigravity'?{'user-hook':{enabled:false}}:{hooks:{}}));
    }
    mkdirSync(join(roots.antigravity,'antigravity-cli'),{recursive:true});
    const before=Object.fromEntries(Object.entries(files).map(([client,file])=>[client,readFileSync(file,'utf8')]));
    const env:NodeJS.ProcessEnv={...process.env,HOME:directory,USERPROFILE:directory,
      OPENCRAWL_CONFIG_HOME:join(directory,'config'),OPENCRAWL_NO_UPDATE:'1',OPENCRAWL_API_URL:'https://self.example',OPENCRAWL_SESSIONS_TOKEN:'selected-client-fixture',
      CLAUDE_CONFIG_DIR:roots['claude-code'],CODEX_HOME:roots.codex,CURSOR_CONFIG_DIR:roots.cursor,ANTIGRAVITY_HOME:roots.antigravity,
    };
    for(const name of ['OPENCRAWL_TOKEN','OPENCRAWL_WORKSPACE_TOKEN','REPLICAS_WORKSPACE_ID','CLAUDE_CODE_REMOTE'])delete env[name];
    const args=[process.execPath,resolve(import.meta.dir,'../src/cli.ts'),'collect','install','--yes','--defer-auth','--backfill','skip','--harness',harness,'--api','https://self.example','--json'];
    const result=Bun.spawnSync(args,{env,stdout:'pipe',stderr:'pipe'});
    if(result.exitCode!==0)throw new Error(result.stdout.toString()+result.stderr.toString());
    const output=JSON.parse(result.stdout.toString()).data;
    const selected=harness==='agy'?'antigravity':harness;
    expect(output.harnesses).toEqual([selected]);
    expect(output.skills.results.flatMap((item:any)=>item.clients)).toEqual(selected==='grok-bot'?[]:[selected]);
    const skillFiles={
      'claude-code':join(roots['claude-code'],'skills','opencrawl','SKILL.md'),
      codex:join(directory,'.agents','skills','opencrawl','SKILL.md'),
      cursor:join(roots.cursor,'skills','opencrawl','SKILL.md'),
      antigravity:join(roots.antigravity,'config','skills','opencrawl','SKILL.md'),
    };
    for(const [client,file] of Object.entries(skillFiles))expect(existsSync(file)).toBe(client===selected);
    for(const [client,file] of Object.entries(files)){
      if(client===selected||selected==='grok-bot'&&client==='cursor')continue;
      expect(readFileSync(file,'utf8')).toBe(before[client]);
    }
  }finally{rmSync(directory,{recursive:true,force:true});}
});
