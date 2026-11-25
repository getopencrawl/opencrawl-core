import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile, spawn} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixtureToken, startFileServer} from './fixtures/shared-files-http.mjs';

import {fileRepositories,matchingExistingRepository,provisionAllocatedRepository,provisionRepository} from '../dist/src/files/store.mjs';
import {admitPush} from '../dist/src/files/capacity.mjs';
import {sharedFilesLimits} from '../dist/src/files/git-http.mjs';

const exec = promisify(execFile);
const MiB = 1024 * 1024;

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'opencrawl-files-test-'));
  const rpc = join(root,'rpc');
  await mkdir(rpc);
  const servers = [];
  async function start(overrides = options) {
    const running = await startFileServer(rpc, overrides);
    servers.push(running);
    return running;
  }
  const server = await start();
  t.after(async () => {await Promise.all(servers.map(s => s.close())); await rm(root,{recursive:true,force:true});});
  const git = async (who, dir, ...args) => {
    const result = await exec('git', ['-c', 'http.extraHeader=Authorization: Bearer ' + fixtureToken(who), ...args],
      {cwd:dir, env:{PATH:process.env.PATH, SystemRoot:process.env.SystemRoot,
        GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_EDITOR:'true',
        GIT_AUTHOR_NAME:who, GIT_AUTHOR_EMAIL:who+'@example.invalid',
        GIT_COMMITTER_NAME:who, GIT_COMMITTER_EMAIL:who+'@example.invalid'}, timeout:90000});
    return result.stdout.trim();
  };
  async function remote(who, endpoint = server) {
    const response = await fetch(endpoint.origin + '/api/files', {headers:{authorization:'Bearer ' + fixtureToken(who)}});
    assert.equal(response.status, 200);
    return endpoint.origin + (await response.json()).data.remotePath;
  }
  async function clone(who, name, endpoint) {
    const dir = join(root,name);
    await git(who,root,'clone','--quiet',await remote(who,endpoint),dir);
    return {dir, git:(...args)=>git(who,dir,...args)};
  }
  return {...server, root, git, remote, clone, start};
}
async function edit(agent, file, content) {
  await writeFile(join(agent.dir,file),content);
  await agent.git('add','--',file);
  await agent.git('commit','--quiet','-m',content);
  return agent.git('rev-parse','HEAD');
}

test('independent writers race on one main, readers keep snapshots and conflicting drafts survive', async t => {
  const f = await fixture(t);
  const second = await f.start();
  const [alice,bob,reader] = await Promise.all([f.clone('alice','a'),f.clone('bob','b',second),f.clone('alice','reader')]);
  const seed = await reader.git('rev-parse','HEAD');
  assert.equal(await alice.git('branch','--show-current'),'main');
  await Promise.all([edit(alice,'a.txt','A'),edit(bob,'b.txt','B')]);
  const raced = await Promise.allSettled([alice.git('push','origin','main'),bob.git('push','origin','main')]);
  assert.equal(raced.filter(result => result.status === 'fulfilled').length,1, JSON.stringify(raced));
  const retry = raced[0].status === 'rejected' ? alice : bob;
  await retry.git('pull','--rebase','origin','main');
  await retry.git('push','origin','main');
  assert.equal(await reader.git('rev-parse','HEAD'),seed);
  const repository = await f.store.open('team-a');
  assert.equal(repository, await second.store.open('team-a'));
  const pushers = (await f.git('alice',repository,'reflog','show','--format=%ge','refs/heads/main')).split('\n');
  for (const who of ['alice','bob']) assert.ok(pushers.includes(Buffer.from(who).toString('base64url')+'@opencrawl.invalid'),pushers);
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
  assert.equal(await f.git('alice',repository,'rev-parse','main'),published);

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
  let revokeDuringReceive = false;
  let receiveChecks = 0;
  const f = await fixture(t, {beforeRevalidate(req, who, revoked) {
    if (revokeDuringReceive && who === 'bob' && req.method === 'POST' && req.url.endsWith('/git-receive-pack')) {
      // Admission succeeds. Withdraw access at the next check, after Git starts receiving the pack.
      if (++receiveChecks === 2) revoked.add(who);
    }
  }});
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
  revokeDuringReceive = true;
  await assert.rejects(bob.git('push'));
  assert.ok(f.revoked.has('bob'), 'the authenticated push reached its final membership check');
  assert.equal(await bob.git('rev-parse','HEAD'),unsubmitted);
  assert.equal(await f.git('alice',await f.store.open('team-a'),'rev-parse','main'),head);
  await assert.rejects(bob.git('fetch'));
  const denied = await fetch(f.origin+'/api/files',{headers:{authorization:'Bearer '+fixtureToken('bob')}});
  assert.equal(denied.status,401);
});

async function storedObjects(repo) {
  const root = join(repo,'objects');
  const paths = await readdir(root,{recursive:true,withFileTypes:true});
  const entries = await Promise.all(paths.filter(entry => entry.isFile()).map(async entry => {
    const path = join(entry.parentPath,entry.name);
    return [path, await stat(path)];
  }));
  return new Map(entries);
}

test('a 33 MiB incompressible object survives restart and a later small push reuses its stored bytes', {timeout:120000}, async t => {
  const f = await fixture(t);
  const writer = await f.clone('alice','producer');
  const payload = randomBytes(33 * 1024 * 1024);
  const expected = createHash('sha256').update(payload).digest('hex');
  await writeFile(join(writer.dir,'sample.bin'),payload);
  await writer.git('add','sample.bin');
  await writer.git('commit','-m','Share random binary sample');
  await writer.git('push','origin','main');
  const repo = await f.store.open('team-a');
  const first = await storedObjects(repo);
  const large = [...first].filter(([,info]) => info.size >= payload.length * 0.99);
  assert.ok(large.length, 'the persistent object store has the original blob or Git pack');

  await f.close();
  const restarted = await f.start();
  assert.equal(await restarted.store.open('team-a'),repo);
  const reader = await f.clone('bob','consumer',restarted);
  assert.equal(createHash('sha256').update(await readFile(join(reader.dir,'sample.bin'))).digest('hex'),expected);
  const secondHead = await edit(reader,'manifest.txt',expected);
  await reader.git('push','origin','main');

  const second = await storedObjects(repo);
  for (const [path, before] of large) {
    const after = second.get(path);
    assert.ok(after, 'the small push retained the large pack or loose blob');
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  }
  const addedBytes = [...second].reduce((sum,[path,info]) => sum + (first.has(path) ? 0 : info.size),0);
  assert.ok(addedBytes < 1024*1024, 'the small push wrote '+addedBytes+' bytes of additional Git objects');
  await writer.git('remote','set-url','origin',await f.remote('alice',restarted));
  await writer.git('pull','--ff-only','origin','main');
  assert.equal(await writer.git('rev-parse','HEAD'),secondHead);
  assert.equal(await readFile(join(writer.dir,'manifest.txt'),'utf8'),expected);
});

test('configured admission limits reserve capacity for other networks and reject oversized pushes atomically', {timeout:30000}, async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let hold = true;
  const f = await fixture(t, {
    limits:{total:2,network:1,pushBytes:1024},
    async beforeRevalidate(req, who) {
      if (hold && who === 'alice' && req.url.endsWith('service=git-upload-pack')) {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const headers = who => ({authorization:'Bearer '+fixtureToken(who)});
  const refs = (remote, who) => fetch(remote+'/info/refs?service=git-upload-pack', {headers:headers(who),signal:t.signal});
  const [a,b] = await Promise.all([f.remote('alice'),f.remote('other')]);
  const pending = refs(a,'alice');
  try {
    await Promise.race([entered.promise, pending.then(() => {throw new Error('First transfer finished before admission was held');})]);
    const busy = await refs(a,'bob');
    assert.equal(busy.status,429);
    assert.ok(Number(busy.headers.get('retry-after'))>0);
    await busy.text();
    const other = await refs(b,'other');
    assert.equal(other.status,200);
    await other.arrayBuffer();
  } finally {
    hold = false;
    release.resolve();
  }
  const resumed = await pending;
  assert.equal(resumed.status,200);
  assert.ok((await resumed.arrayBuffer()).byteLength > 0);

  const writer = await f.clone('alice','limited');
  const base = await writer.git('rev-parse','main');
  await writeFile(join(writer.dir,'oversized.bin'),randomBytes(16*1024));
  await writer.git('add','oversized.bin');
  await writer.git('commit','-m','File larger than the configured transfer limit');
  await assert.rejects(writer.git('push','origin','main'));
  assert.equal(await writer.git('ls-remote','--refs','origin'),base+'\trefs/heads/main');
  assert.equal(await writer.git('rev-list','--count','origin/main..main'),'1');
});

test('published history consumes quota; a rejected draft remains local and a different workspace can publish', async t => {
  const f = await fixture(t);
  const agent = await f.clone('alice','quota-a');
  await writeFile(join(agent.dir,'history.bin'),randomBytes(2*MiB));
  await agent.git('add','history.bin');
  await agent.git('commit','-m','Share data');
  await agent.git('push');
  await agent.git('rm','history.bin');
  await agent.git('commit','-m','Retain data in history');
  await agent.git('push');
  const baseline = await agent.git('rev-parse','main');
  const repo = await f.store.open('team-a');
  const before = [...(await storedObjects(repo)).keys()].sort();
  const limited = await f.start({limits:{...sharedFilesLimits({}), repositoryBytes: 2*MiB}});
  await agent.git('remote','set-url','origin',await f.remote('alice',limited));
  await edit(agent,'draft','new measurement');
  await assert.rejects(agent.git('push'),/507/);
  assert.equal(await agent.git('ls-remote','--refs','origin'),baseline+'\trefs/heads/main');
  assert.equal(await agent.git('rev-list','--count','origin/main..main'),'1');
  assert.deepEqual([...(await storedObjects(repo)).keys()].sort(),before);
  const other = await f.clone('other','quota-b',limited);
  const head = await edit(other,'report','independent publication');
  await other.git('push');
  assert.equal(await other.git('ls-remote','--refs','origin'),head+'\trefs/heads/main');

  const readOnly = await f.start({limits:{...sharedFilesLimits({}),minFreeBytes:Number.MAX_SAFE_INTEGER}});
  await agent.git('remote','set-url','origin',await f.remote('alice',readOnly));
  await assert.rejects(agent.git('push'),/507/);
  const noNew = fileRepositories(f.store.storageRoot,'files-test',undefined,
    {...sharedFilesLimits({}),minFreeBytes:Number.MAX_SAFE_INTEGER});
  await noNew.ready();
  await assert.rejects(noNew.open('never-initialized'),{status:507});
  assert.equal(await noNew.open('team-a'),repo);
  const reader = await f.clone('bob','reader-under-pressure',readOnly);
  assert.equal(await reader.git('rev-parse','main'),baseline);
});

test('workspace writer leases survive replica races and an abandoned quarantine is reclaimed after process loss', {timeout:30000}, async t => {
  const f = await fixture(t);
  const root = f.store.storageRoot;
  const [alpha,beta] = await Promise.all([f.store.open('team-a'), f.store.open('team-b')]);
  const limits = sharedFilesLimits({});
  // Use a separate OS process: a fatal exit must release both its writer and
  // its volume reservation without deleting a live peer's lock file.
  const program = [
    "import {admitPush} from " + JSON.stringify(new URL('../dist/src/files/capacity.mjs',import.meta.url).href),
    "import {mkdir,writeFile} from 'node:fs/promises'",
    "import {join} from 'node:path'",
    "const [root,dir,limits] = process.argv.slice(1)",
    "const lease = await admitPush(root,dir,JSON.parse(limits))",
    "const pending=join(dir,'objects','incoming-abandoned')",
    "await mkdir(pending)",
    "await writeFile(join(pending,'fixture'),Buffer.alloc(4096))",
    "process.send('ready')",
    "process.on('message', () => {})",
  ].join(';');
  const child = spawn(process.execPath,['--input-type=module','-e',program,root,alpha,JSON.stringify(limits)],{stdio:['ignore','ignore','inherit','ipc']});
  const closed = once(child,'close');
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); await closed;});
  await Promise.race([once(child,'message'),closed.then(()=>{throw Error('lease holder exited before acquiring the workspace');})]);
  const abandoned = join(alpha,'objects','incoming-abandoned');
  await assert.rejects(admitPush(root,alpha,limits),{status:429});
  assert.equal((await stat(join(abandoned,'fixture'))).size,4096);
  const other = await admitPush(root,beta,limits);
  await other.release();
  const records = () => readdir(join(root,'.receive-capacity')).then(names=>names.filter(name=>name.endsWith('.reserve')));
  assert.ok((await records()).length>=1);
  const sentinel = join(alpha,'objects','info','retain');
  await writeFile(sentinel,'operator metadata');
  child.kill('SIGKILL');
  await closed;
  const recovered = await admitPush(root,alpha,limits);
  try {
    assert.equal((await records()).length,1);
    await assert.rejects(stat(abandoned),{code:'ENOENT'});
    assert.equal(await readFile(sentinel,'utf8'),'operator metadata');
  } finally {await recovered.release();}
});

test('parallel tenants cannot both reserve the same free disk bytes', async t => {
  const f=await fixture(t);
  const [alpha,beta]=await Promise.all([f.store.open('team-a'),f.store.open('team-b')]);
  const root=f.store.storageRoot;
  const limits={...sharedFilesLimits({}),minFreeBytes:8*MiB,pushBytes:4*MiB};
  // Model a 32 MiB volume with all bytes free, independent of the CI runner's disk.
  const free=async()=>32*MiB;
  const first=await admitPush(root,alpha,limits,free);
  try {
    assert.ok(first.maxPack>0 && first.maxPack<limits.pushBytes);
    await assert.rejects(admitPush(root,beta,limits,free),{status:507});
  } finally {await first.release();}
  const second=await admitPush(root,beta,limits,free);
  try {assert.equal(second.maxPack,first.maxPack);} finally {await second.release();}
});

test('allocated Git identities survive retries and refuse an unrelated or unmarked disk', async t => {
  const root=await mkdtemp(join(tmpdir(),'opencrawl-git-allocation-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=fileRepositories(root,'isolated'),allocated=randomUUID();
  await store.ready();
  const materialize=(tenant,id)=>provisionAllocatedRepository(root,'isolated',tenant,id);
  assert.deepEqual(await Promise.all([materialize('one',allocated),materialize('one',allocated)]),[allocated,allocated]);
  const dir=await matchingExistingRepository(root,'isolated','one',allocated);
  assert.equal(await readFile(join(dir,'opencrawl-repository-id'),'utf8'),allocated);
  await assert.rejects(materialize('one',randomUUID()),/Restore the registered/);
  const orphan=await provisionRepository(store,'orphan');
  await assert.rejects(materialize('orphan',randomUUID()),/Restore the registered/);
  assert.equal(await provisionRepository(store,'orphan'),orphan);
  await rm(join(dir,'opencrawl-repository-id'));
  await assert.rejects(materialize('one',allocated),/Restore the registered/);
  await assert.rejects(materialize('invalid','bad uuid'),/Invalid allocated/);
});
