import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {devNull, tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {applicationDatabaseFixture, postgresUrl} from './fixtures/application-database.mjs';
import {postgresSharedFiles} from '../dist/src/files/store.mjs';

const exec = promisify(execFile);
async function git(dir,args,extra={}) {
  const {stdout} = await exec('git', args, {cwd:dir,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull,GIT_AUTHOR_NAME:'Agent',GIT_AUTHOR_EMAIL:'agent@example.invalid',
    GIT_COMMITTER_NAME:'Agent',GIT_COMMITTER_EMAIL:'agent@example.invalid',...extra}});
  return stdout.trim();
}

test('verified legacy history migrates once; native ref and authenticated push audit survive restart', {skip:!postgresUrl}, async t => {
  const db = await applicationDatabaseFixture(t);
  const root = await mkdtemp(join(tmpdir(),'opencrawl-files-migrate-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const client = join(root,'old-clone'), storage = join(root,'repositories');
  await Promise.all([mkdir(client),mkdir(storage)]);
  await git(client,['init','--quiet','--initial-branch=main']);
  async function commit(contents) {
    await writeFile(join(client,'handoff'),contents);
    await git(client,['add','handoff']);
    await git(client,['commit','--quiet','-m',contents]);
    return git(client,['rev-parse','HEAD']);
  }
  const first = await commit('first version');
  const legacyHead = await commit('last legacy version');
  const bundleFile = join(root,'old.bundle');
  await git(client,['bundle','create',bundleFile,'refs/heads/main']);
  const oldBundle = await readFile(bundleFile);
  const tenant = 'legacy-network';

  // Use the schema from the shipped bundle implementation, before v1 startup.
  await db.transaction(async sql => {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:shared-files:schema',0))");
    await sql.query(`CREATE TABLE IF NOT EXISTS opencrawl_shared_files (
      namespace text NOT NULL, tenant_id text NOT NULL, head text NOT NULL,
      bundle bytea NOT NULL CHECK (octet_length(bundle) <= 8388608), PRIMARY KEY(namespace,tenant_id))`);
    await sql.query(`CREATE TABLE IF NOT EXISTS opencrawl_shared_file_pushes (
      namespace text NOT NULL, tenant_id text NOT NULL, head text NOT NULL, previous_head text,
      user_id text NOT NULL, pushed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(namespace,tenant_id,head))`);
    await sql.query('INSERT INTO opencrawl_shared_files(namespace,tenant_id,head,bundle) VALUES($1,$2,$3,$4),($1,$5,$6,$4)',
      [db.namespace,tenant,legacyHead,oldBundle,'wrong-declared-head',first]);
    await sql.query('INSERT INTO opencrawl_shared_file_pushes(namespace,tenant_id,head,previous_head,user_id) VALUES($1,$2,$3,$4,$5)',
      [db.namespace,tenant,legacyHead,first,'previous-member']);
  });
  const original = postgresSharedFiles(db,storage), second = postgresSharedFiles(db,storage);
  await Promise.all([original.ready(),second.ready()]);
  await assert.rejects(original.open('wrong-declared-head'));
  await db.pool.query('UPDATE opencrawl_shared_files SET head=$3 WHERE namespace=$1 AND tenant_id=$2',
    [db.namespace,'wrong-declared-head',legacyHead]);
  const repaired = await original.open('wrong-declared-head');
  assert.equal(await git(repaired,['rev-parse','main']),legacyHead);
  const [dir,duplicate] = await Promise.all([original.open(tenant),second.open(tenant)]);
  assert.equal(dir,duplicate);
  assert.notEqual(dir,repaired);
  assert.equal(await git(dir,['rev-parse','main']),legacyHead);
  assert.equal(await git(dir,['show',first+':handoff']),'first version');

  // Simulate process loss after Git durably commits main and its reflog, before SQL audit sync.
  const next = await commit('new native version');
  await git(dir,['fetch','--no-tags','--no-write-fetch-head',client,next]);
  const user = 'member-with-an-opaque-id';
  await git(dir,['update-ref','-m','push','refs/heads/main',next,legacyHead],
    {GIT_COMMITTER_NAME:'OpenCrawl',GIT_COMMITTER_EMAIL:Buffer.from(user).toString('base64url')+'@opencrawl.invalid'});
  const restarted = postgresSharedFiles(db,storage);
  await restarted.ready();
  const recovered = await restarted.open(tenant);
  assert.equal(recovered,dir);
  assert.equal(await git(recovered,['rev-parse','main']),next);
  await restarted.syncAudit(tenant,recovered);
  await restarted.syncAudit(tenant,recovered);
  const {rows} = await db.pool.query('SELECT head, previous_head, user_id FROM opencrawl_shared_file_pushes WHERE namespace=$1 AND tenant_id=$2 AND head=ANY($3::text[])',
    [db.namespace,tenant,[legacyHead,next]]);
  assert.deepEqual(rows.sort((a,b)=>a.head.localeCompare(b.head)), [
    {head:legacyHead,previous_head:first,user_id:'previous-member'},
    {head:next,previous_head:legacyHead,user_id:user},
  ].sort((a,b)=>a.head.localeCompare(b.head)));

  // A removed repository must never get reseeded (or fall back to the old SQL bundle).
  const offline = join(root,'offline-repository');
  await rename(recovered,offline);
  try {
    const newProcess = postgresSharedFiles(db,storage);
    await newProcess.ready();
    await assert.rejects(newProcess.open(tenant));
  } finally {await rename(offline,recovered);}
});
