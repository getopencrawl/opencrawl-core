import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {devNull, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureToken, startFileServer} from './fixtures/shared-files-http.mjs';

const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opencrawl-files-test-'));
  const rpc = join(root,'rpc');
  await mkdir(rpc);
  const server = await startFileServer(rpc);
  t.after(async () => {await server.close(); await rm(root,{recursive:true,force:true});});
  const git = async (who, dir, ...args) => {
    const result = await exec('git', ['-c', 'http.extraHeader=Authorization: Bearer ' + fixtureToken(who), ...args],
      {cwd:dir, env:{PATH:process.env.PATH, SystemRoot:process.env.SystemRoot,
        GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:devNull, GIT_TERMINAL_PROMPT:'0', GIT_EDITOR:'true',
        GIT_AUTHOR_NAME:who, GIT_AUTHOR_EMAIL:who+'@example.invalid',
        GIT_COMMITTER_NAME:who, GIT_COMMITTER_EMAIL:who+'@example.invalid'}, timeout:20000});
    return result.stdout.trim();
  };
  async function remote(who) {
    const response = await fetch(server.origin + '/api/files', {headers:{authorization:'Bearer ' + fixtureToken(who)}});
    assert.equal(response.status, 200);
    return server.origin + (await response.json()).data.remotePath;
  }
  async function clone(who, name) {
    const dir = join(root,name);
    await git(who,root,'clone','--quiet',await remote(who),dir);
    return {dir, git:(...args)=>git(who,dir,...args)};
  }
  return {...server, root, git, remote, clone};
}
async function edit(agent, file, content) {
  await writeFile(join(agent.dir,file),content);
  await agent.git('add','--',file);
  await agent.git('commit','--quiet','-m',content);
  return agent.git('rev-parse','HEAD');
}

test('independent writers race on one main, readers keep snapshots and conflicting drafts survive', async t => {
  const f = await fixture(t);
  const [alice,bob,reader] = await Promise.all([f.clone('alice','a'),f.clone('bob','b'),f.clone('alice','reader')]);
  const seed = await reader.git('rev-parse','HEAD');
  assert.equal(await alice.git('branch','--show-current'),'main');
  await Promise.all([edit(alice,'a.txt','A'),edit(bob,'b.txt','B')]);
  const raced = await Promise.allSettled([alice.git('push','origin','main'),bob.git('push','origin','main')]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length,1, JSON.stringify(raced));
  const retry = raced[0].status === 'rejected' ? alice : bob;
  await retry.git('pull','--rebase','origin','main');
  await retry.git('push','origin','main');
  assert.equal(await reader.git('rev-parse','HEAD'),seed);
  assert.deepEqual(f.audit.map(push=>push.user).sort(),['alice','bob']);
  for (const agent of [alice,bob,reader]) await agent.git('pull','--ff-only','origin','main');
  assert.equal(await reader.git('ls-tree','--name-only','HEAD'),'a.txt\nb.txt');

  const previous = await alice.git('rev-parse','HEAD');
  const published = await edit(alice,'a.txt','published');
  const draft = await edit(bob,'a.txt','draft');
  await alice.git('push','origin','main');
  await assert.rejects(bob.git('push','--force','origin','main'));
  await assert.rejects(bob.git('pull','--rebase','origin','main'));
  assert.equal(await bob.git('diff','--name-only','--diff-filter=U'),'a.txt');
  await bob.git('rebase','--abort');
  assert.equal(await bob.git('rev-parse','HEAD'),draft);
  assert.equal(await readFile(join(bob.dir,'a.txt'),'utf8'),'draft');
  assert.equal(f.history.get('team-a').head,published);

  for (const ref of ['HEAD:refs/heads/side','HEAD:refs/tags/side',':refs/heads/main'])
    await assert.rejects(alice.git('push','origin',ref));
  assert.equal(await alice.git('ls-remote','--refs','origin'),published+'\trefs/heads/main');
  await reader.git('pull','--ff-only');
  await reader.git('rm','a.txt');
  await reader.git('commit','-m','remove published file');
  await reader.git('push');
  assert.equal(await reader.git('show',previous+':a.txt'),'A');
});

test('network and membership bind discovery, transfers, and final publication', async t => {
  const f = await fixture(t);
  const alice = await f.clone('alice','a');
  const shared = await f.remote('alice');
  const other = await f.remote('other');
  assert.notEqual(shared,other);
  const head = await edit(alice,'report','network-one-report');
  await alice.git('push');
  await assert.rejects(f.git('other',f.root,'ls-remote',shared));
  const isolated = await f.clone('other','other');
  assert.equal(await isolated.git('ls-tree','--name-only','HEAD'),'');
  await assert.rejects(isolated.git('fetch','origin',head));
  for (const service of ['git-upload-pack','git-receive-pack']) {
    const denied = await fetch(shared+'/'+service,{method:'POST',
      headers:{authorization:'Bearer '+fixtureToken('other'),'content-type':'application/x-'+service+'-request'},body:'0000'});
    assert.equal(denied.status,404);
    await denied.text();
  }

  const bob = await f.clone('bob','b');
  const unsubmitted = await edit(bob,'draft','retained locally');
  const normalRead = f.store.read;
  // Allow ref advertisement, then revoke during the actual push.
  let reads = 0;
  f.store.read = async tenant => {
    const snapshot = await normalRead(tenant);
    if (++reads === 2) f.revoked.add('bob');
    return snapshot;
  };
  await assert.rejects(bob.git('push'));
  assert.equal(reads,2);
  assert.equal(await bob.git('rev-parse','HEAD'),unsubmitted);
  assert.equal(f.history.get('team-a').head,head);
  await assert.rejects(bob.git('fetch'));
  const denied = await fetch(f.origin+'/api/files',{headers:{authorization:'Bearer '+fixtureToken('bob')}});
  assert.equal(denied.status,401);
});
