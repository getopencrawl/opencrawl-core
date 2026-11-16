import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApplicationDatabase,requireApplicationStateReady} from '../dist/src/state/postgres.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {applicationStateSettings} from '../dist/src/state/settings.mjs';

const connectionString=process.env.OPENCRAWL_TEST_POSTGRES_URL;
const live=(name,run)=>test(name,{skip:!connectionString},run);
const ref=(changes={})=>({environment:'selfhost',tenantId:'org_alpha',userId:'user_owner',integrationId:'int_connection',commandId:randomUUID(),...changes});
async function fixture(t){
  const database=createApplicationDatabase({connectionString,namespace:'app-state-test-'+randomUUID()});
  const encryptionKey=randomBytes(32),commands=createIntegrationCommands({database,environment:'selfhost',encryptionKey});
  await commands.ready();
  t.after(async()=>{
    await database.pool.query('DELETE FROM opencrawl_integration_commands WHERE namespace=$1',[database.namespace]);
    await database.pool.query('DELETE FROM opencrawl_application_migrations WHERE namespace=$1',[database.namespace]);
    await database.pool.query('DELETE FROM opencrawl_application_installations WHERE namespace=$1',[database.namespace]);
    await database.transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");
      await client.query(`DROP SCHEMA ${database.identitySchema} CASCADE`);
    });
    await database.close();
  });
  return {database,commands,encryptionKey,enqueue:(reference,operation='provision',secret={apiKey:'private-key'},actor='user_admin')=>database.transaction(client=>commands.transactional.enqueue(client,reference,operation,secret,actor))};
}

test('application binding stays stable across endpoint and credential rotations',()=>{
  const base={OPENCRAWL_DATABASE_URL:'postgres://operator@database/app',OPENCRAWL_LANDING_S3_BUCKET:'source',OPENCRAWL_LANDING_S3_PATH:'sessions/v1',OPENCRAWL_ORGANIZATION_ID:'org_alpha'};
  assert.deepEqual(applicationStateSettings(base),applicationStateSettings({...base,OPENCRAWL_LANDING_S3_ENDPOINT:'https://rotated.example',OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY:'rotated'}));
  assert.notEqual(applicationStateSettings(base).namespace,applicationStateSettings({...base,OPENCRAWL_LANDING_S3_PATH:'sessions/other'}).namespace);
  assert.throws(()=>applicationStateSettings({...base,OPENCRAWL_LANDING_S3_PATH:'../another'}),/prefix/);
});

live('schema initialization never implicitly admits an unmigrated application',async t=>{
  const f=await fixture(t);
  await assert.rejects(requireApplicationStateReady(f.database),{status:503});
  await f.database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state) VALUES($1,'{}',$2,'importing')",[f.database.namespace,randomUUID()]);
  await assert.rejects(requireApplicationStateReady(f.database),{status:503});
  await f.database.pool.query("UPDATE opencrawl_application_installations SET state='ready',verified_at=now() WHERE namespace=$1",[f.database.namespace]);
  await requireApplicationStateReady(f.database);
});

live('commands and encrypted secret handoff roll back with their enclosing state transaction',async t=>{
  const f=await fixture(t),reference=ref();
  await assert.rejects(f.database.transaction(async client=>{
    await f.commands.transactional.enqueue(client,reference,'provision',{apiKey:'must-not-survive'},'user_admin');
    throw new Error('desired state failed');
  }),/desired state failed/);
  assert.equal(await f.commands.read(reference),null);
  assert.deepEqual(await f.commands.readSecret(reference),{});
  await f.enqueue(reference);
  const row=(await f.database.pool.query('SELECT ciphertext FROM opencrawl_integration_command_secrets WHERE namespace=$1',[f.database.namespace])).rows[0];
  assert.equal(row.ciphertext.includes(Buffer.from('private-key')),false);
  const metadata=await f.commands.read(reference);
  assert.equal(metadata.requestedBy,'user_admin');
  assert.equal(JSON.stringify(metadata).includes('private-key'),false);
  assert.deepEqual(await f.commands.readSecret(reference),{apiKey:'private-key'});
});

live('tenant and owner scope constrain command lookup and secret envelopes',async t=>{
  const f=await fixture(t),reference=ref();await f.enqueue(reference);
  assert.equal(await f.commands.read({...reference,tenantId:'org_other'}),null);
  assert.deepEqual(await f.commands.readSecret({...reference,userId:'user_other'}),{});
  await assert.rejects(f.commands.complete({...reference,tenantId:'org_other'}),{status:403});
  await assert.rejects(f.commands.read({...reference,environment:'production'}),{status:403});
  const foreign=ref({tenantId:'org_other'});await f.enqueue(foreign);
  await f.database.pool.query(`UPDATE opencrawl_integration_command_secrets SET ciphertext=(SELECT ciphertext FROM opencrawl_integration_command_secrets WHERE namespace=$1 AND tenant_id=$2 LIMIT 1) WHERE namespace=$1 AND tenant_id=$3`,[f.database.namespace,reference.tenantId,foreign.tenantId]);
  await assert.rejects(f.commands.readSecret(foreign));
});

live('concurrent retry creates one durable command; terminal state never revives secrets',async t=>{
  const f=await fixture(t),reference=ref();
  await Promise.all(Array.from({length:8},()=>f.enqueue(reference)));
  assert.equal((await f.commands.listPending({})).commands.length,1);
  await f.commands.complete(reference);await f.enqueue(reference);
  assert.equal((await f.commands.read(reference)).status,'completed');
  assert.deepEqual(await f.commands.readSecret(reference),{});
  assert.equal((await f.commands.listPending({})).commands.length,0);
  await assert.rejects(f.enqueue(reference,'disconnect',{},'user_admin'),{status:409});
});

live('superseding and failing commands remove secrets and pending recovery work',async t=>{
  const f=await fixture(t),first=ref(),second=ref();await f.enqueue(first);await f.enqueue(second);
  await f.database.transaction(client=>f.commands.transactional.supersede(client,first));
  await f.commands.fail(second,'authorization_denied');
  assert.equal((await f.commands.read(first)).status,'superseded');
  assert.equal((await f.commands.read(second)).failureReason,'authorization_denied');
  assert.deepEqual((await f.commands.listPending({})).commands,[]);
  assert.equal((await f.database.pool.query('SELECT count(*)::int AS n FROM opencrawl_integration_command_secrets WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
});

live('recovery pagination is bounded and scoped to its installation',async t=>{
  const f=await fixture(t),other=await fixture(t);
  for(let i=0;i<5;i++)await f.enqueue(ref());
  const first=await f.commands.listPending({limit:2});assert.equal(first.commands.length,2);assert.ok(first.cursor);
  await assert.rejects(other.commands.listPending({cursor:first.cursor}),{status:403});
  const second=await f.commands.listPending({cursor:first.cursor,limit:2});
  const third=await f.commands.listPending({cursor:second.cursor,limit:2});
  assert.equal(new Set([...first.commands,...second.commands,...third.commands].map(r=>r.commandId)).size,5);
  assert.equal(third.cursor,null);
});
