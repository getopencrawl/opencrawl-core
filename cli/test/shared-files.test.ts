import {expect, test} from 'bun:test';
import {mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

test('shared-file sessions open outside the project, preserve drafts and scope Git credentials', async () => {
  const root = await mkdtemp(join(tmpdir(),'opencrawl-files-cli-'));
  const project = join(root,'working-project');
  const cwd = join(project,'nested');
  const temp = join(project,'scratch');
  const home = join(root,'home');
  const rpc = join(root,'rpc');
  await Promise.all([cwd,temp,home,rpc].map(path => mkdir(path,{recursive:true})));
  // A customer tool can install a default HTTP credential in the user's Git profile.
  // The shared-files clone must clear it before fetching data or credentials.
  const gitProfile = join(home,'gitconfig');
  await writeFile(gitProfile,'[http]\n  extraHeader = Authorization: Bearer unrelated-fixture-token\n');
  const server = Bun.spawn(['node',resolve(import.meta.dir,'fixtures/shared-files-server.mjs'),rpc],
    {env:process.env,stdout:'pipe',stderr:'pipe'});
  const diagnostics = new Response(server.stderr).text();
  let failure: unknown;
  try {
    const startup = server.stdout.getReader();
    const first = await startup.read();
    if (first.done) throw new Error(await diagnostics);
    startup.releaseLock();
    const api = new TextDecoder().decode(first.value).trim();
    const token = 'fixture-token-alice';
    const env = {...process.env, OPENCRAWL_CONFIG_HOME:join(home,'config'), OPENCRAWL_TOKEN:token,
      OPENCRAWL_API_URL:api, OPENCRAWL_NO_UPDATE:'1', HOME:home, USERPROFILE:home,
      GIT_CEILING_DIRECTORIES:project, TMPDIR:temp, TEMP:temp, TMP:temp, GIT_CONFIG_GLOBAL:gitProfile, GIT_CONFIG_NOSYSTEM:'1', GIT_TERMINAL_PROMPT:'0'};
    const entry = [process.execPath,resolve(import.meta.dir,'../src/cli.ts')];
    async function run(cmd: string[], options: {cwd?:string; token?:string; input?:string; failure?:boolean; stderr?:boolean} = {}) {
      const child = Bun.spawn(cmd,{cwd:options.cwd ?? cwd,env:{...env,OPENCRAWL_TOKEN:options.token ?? token},
        stdin:new Blob([options.input ?? '']),stdout:'pipe',stderr:'pipe'});
      const [out,err,code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      if (options.failure) expect(code).not.toBe(0);
      else if (code !== 0) throw new Error('Command failed: ' + err + out);
      return (options.stderr ? err : out).trim();
    }
    const open = (session:string) => [...entry,'files','open','--api',api,'--session',session];
    // Setup may predate the workspace rollout. Stock Git is the first client
    // command after enablement: no new setup, startup hook or files command.
    // Exercise fresh personal setup on macOS and Linux, machine enrollment on Windows.
    const setupToken=process.platform==='win32'?'fixture-token-registered':token;
    if(setupToken!==token){
      const profile=join(home,'config','opencrawl');
      await mkdir(profile,{recursive:true});
      const key=createHash('sha256').update(api).digest('hex');
      await writeFile(join(profile,key+'.json'),JSON.stringify({
        auth:{clientId:'fixture',tokenEndpoint:api+'/token'},accessToken:setupToken,refreshToken:'fixture-refresh',
        expiresAt:Date.now()+3600000,registrationId:'agent_reg_fixture'
      }),{mode:0o600});
    }
    const setup = JSON.parse(await run([...entry,'setup','apply','--plugins','none','--forward','none','--history','none','--yes','--json','--api',api],{token:setupToken}));
    expect(setup.data).toMatchObject({status:'recording_off'});
    expect(setup.data).not.toHaveProperty('gitCredentials');
    expect(JSON.stringify(setup)).not.toContain('/files.git');
    await writeFile(join(rpc,'enabled'),'on');
    const firstClone=join(root,'first-plain-clone');
    await mkdir(firstClone);
    await run(['git','-C',firstClone,'clone',api+'/git/team-a/files.git','.'],{token:setupToken});
    expect(await run(['git','-C',firstClone,'branch','--show-current'])).toBe('main');
    await run(['git','-C',project,'init','--initial-branch=customer-draft']);
    await writeFile(join(project,'notes'),'customer WIP');
    await run(['git','-C',project,'add','notes']);
    await writeFile(join(project,'notes'),'customer WIP plus unstaged updates');
    const customerStatus = () => run(['git','-C',project,'status','--porcelain=v1']);
    const before = await customerStatus();
    expect(before).toContain('AM notes');

    // Two callers can resume the same session while a separate session has its own clone.
    const opened = await Promise.allSettled([run(open('alpha')),run(open('alpha')),run(open('beta'))]);
    const [a,resume,b] = opened.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(a).toBe(resume);
    expect(a).not.toBe(b);
    // Directly inspect the checkout on disk as well as comparing canonical paths.
    const nestedClones = (await readdir(temp)).filter(name => name.startsWith('opencrawl-files-'));
    expect(nestedClones, 'A new shared clone was created under '+temp).toEqual([]);
    for (const path of [a,b]) {
      expect(isAbsolute(path)).toBe(true);
      const diff = relative(await realpath(project),await realpath(path));
      expect(diff === '..' || diff.startsWith('..'+sep) || isAbsolute(diff), JSON.stringify({project,path,diff})).toBe(true);
    }
    const config = await readFile(join(a,'.git','config'),'utf8');
    expect(config).not.toContain(token);
    const remote = await run(['git','-C',a,'remote','get-url','origin']);
    expect(remote).toStartWith(api+'/api/files/');
    expect(remote).not.toContain(token);

    await writeFile(join(a,'handoff.txt'),'agent handoff');
    await run(['git','-C',a,'add','handoff.txt']);
    await run(['git','-C',a,'commit','-m','Share agent handoff']);
    await writeFile(join(a,'unsent.txt'),'uncommitted draft');
    expect(await run(open('alpha'))).toBe(a);
    expect(await readFile(join(a,'unsent.txt'),'utf8')).toBe('uncommitted draft');
    expect(await run(['git','-C',a,'rev-list','--count','origin/main..HEAD'])).toBe('1');
    const fileLink = [...entry,'files','link','handoff.txt','--api',api];
    await run(fileLink,{cwd:a,failure:true}); // The commit is still local.
    await run(['git','-C',a,'push']);
    const revision = await run(['git','-C',a,'rev-parse','HEAD']);
    const workspace = createHash('sha256').update('opencrawl.workspace-link.v1\0team-a').digest().subarray(0,9).toString('base64url');
    expect(await run([...fileLink,'--revision',revision],{cwd:a})).toBe(api+'/files/'+workspace+'/'+revision+'/handoff.txt');
    expect(await run([...entry,'files','link','--api',api],{cwd:a})).toBe(api+'/commits/'+workspace+'/'+revision);
    await run(fileLink,{cwd:a,token:'fixture-token-other',failure:true});
    await run(fileLink,{failure:true});
    await run(['git','-C',b,'pull','--ff-only']);
    expect(await readFile(join(b,'handoff.txt'),'utf8')).toBe('agent handoff');

    // A login switch against the same API cannot use the old session's helper.
    await run(['git','-C',a,'fetch'],{token:'fixture-token-other',failure:true});
    const other = await run(open('alpha'),{token:'fixture-token-other'});
    expect(other).not.toBe(a);
    expect(await run(['git','-C',other,'ls-tree','--name-only','HEAD'])).toBe('');
    const savedHelpers = await run(['git','-C',a,'config','--get-all','credential.helper']);
    const key = savedHelpers.match(/\b([a-f0-9]{64})\b/)?.[1];
    expect(key).toBeDefined();
    const url = new URL(remote);
    for (const input of [
      'protocol=https\nhost=unrelated.invalid\npath='+url.pathname.slice(1)+'\n\n',
      'protocol=http\nhost='+url.host+'\npath=another-workspace.git\n\n',
    ]) {
      expect(await run([...entry,'files-credential',key!,'get'],{input,failure:true})).toBe('');
    }
    expect(await customerStatus()).toBe(before);
    expect(await run(['git','-C',project,'branch','--show-current'])).toBe('customer-draft');
    expect(await run(['git','-C',project,'show',':notes'])).toBe('customer WIP');
    expect(await readFile(join(project,'notes'),'utf8')).toBe('customer WIP plus unstaged updates');

    // An upgraded CLI also repairs an existing profile when a member requests
    // the URL, even if their independently packaged plugin owns SessionStart.
    await run(['git','config','--global','--unset-all','include.path']);
    const cloneUrl = await run([...entry,'files','url','--api',api]);
    expect(cloneUrl).toBe(api+'/git/team-a/files.git');
    const includes = await run(['git','config','--global','--get-all','include.path']);
    expect(includes.split('\n')).toHaveLength(1);
    const human = join(root,'human');
    await mkdir(human);
    await run(['git','-C',human,'clone',cloneUrl,'.']);
    expect(await run(['git','-C',human,'remote','get-url','origin'])).toBe(cloneUrl);
    expect(await readFile(join(human,'handoff.txt'),'utf8')).toBe('agent handoff');
    await writeFile(join(human,'human.txt'),'plain Git');
    await run(['git','-C',human,'add','human.txt']);
    await run(['git','-C',human,'-c','user.name=Member','-c','user.email=member@example.invalid','commit','-m','Share with ordinary Git']);
    await run(['git','-C',human,'push']);
    await run(['git','-C',b,'pull','--ff-only']);
    expect(await readFile(join(b,'human.txt'),'utf8')).toBe('plain Git');
    await writeFile(join(b,'reply.txt'),'from another member');
    await run(['git','-C',b,'add','reply.txt']);
    await run(['git','-C',b,'commit','-m','Reply to handoff']);
    await run(['git','-C',b,'push']);
    await run(['git','-C',human,'pull','--ff-only']);
    expect(await readFile(join(human,'reply.txt'),'utf8')).toBe('from another member');
    await run([...entry,'files','setup-git','--api',api]);
    expect(await run(['git','config','--global','--get-all','include.path'])).toBe(includes);
    // The account and network are verified again when Git later fetches or pushes.
    await run(['git','-C',human,'fetch'],{token:'fixture-token-other',failure:true});
    for(const candidate of [cloneUrl.replace('/team-a/','/team-b/'),api+'/not-git',cloneUrl.replace('127.0.0.1','localhost')]){
      const testUrl=new URL(candidate);
      const input='protocol='+testUrl.protocol.slice(0,-1)+'\nhost='+testUrl.host+'\npath='+testUrl.pathname.slice(1)+'\n\n';
      expect(await run([...entry,'files-credential',api,'get'],{input,failure:true})).toBe('');
    }

    // An older CLI could put a clone under a checkout when Git couldn't find its root.
    const record = join(home,'config','opencrawl','files',key+'.json');
    const binding = JSON.parse(await readFile(record,'utf8'));
    const misplaced = join(temp,'older-clone');
    await rename(binding.scratch,misplaced);
    await writeFile(record,JSON.stringify({...binding,scratch:misplaced}));
    const message = await run(open('alpha'),{failure:true,stderr:true});
    expect(message).toContain(join(misplaced,'repo'));
    expect(await readFile(join(misplaced,'repo','unsent.txt'),'utf8')).toBe('uncommitted draft');
    expect(JSON.parse(await readFile(record,'utf8')).scratch).toBe(misplaced);
  } catch (error) {
    failure = error;
  } finally {
    server.kill('SIGTERM');
    await server.exited;
    if (failure) console.error('Shared-files fixture:', await diagnostics, failure);
    await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
    if (failure) throw failure;
  }
}, 60000);
