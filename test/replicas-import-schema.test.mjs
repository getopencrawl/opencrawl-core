import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Pool} from 'pg';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {createReplicasImport} from '../dist/src/integrations/replicas-import.mjs';
import {postgresUrl,dropTestSchemas} from './fixtures/application-database.mjs';

const principal={tenantId:'test-tenant',userId:'test-admin'};
async function setup(t) {
  const tag=randomUUID().replaceAll('-',''),schema='oc_ready_'+tag;
  const admin=new Pool({connectionString:postgresUrl,max:1});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const config={connectionString:postgresUrl,namespace:'test-'+tag,options:'-c search_path='+schema+' -c lock_timeout=4s',max:3};
  const db=createApplicationDatabase(config),appName='replicas-schema-'+tag;
  const fresh=createApplicationDatabase({...config,application_name:appName});
  const open=database=>createReplicasImport({database,key:randomBytes(32),schedule:assert.fail,ingest:assert.fail,request:assert.fail});
  t.after(async()=>{
    await Promise.all([db.close(),fresh.close()]);
    try{await dropTestSchemas(admin,[schema]);}finally{await admin.end();}
  });
  assert.equal(await open(db).status(principal),null);
  return {db,fresh:open(fresh),appName};
}

test('a fresh Replicas adapter reads a current schema while another connection writes inventory',async t=>{
  const {db,fresh}=await setup(t),writer=await db.pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('LOCK TABLE opencrawl_replicas_workspace_inventories,opencrawl_replicas_deferred IN ROW EXCLUSIVE MODE');
    // A warm bootstrap and the status read must finish while this lock is still held.
    await fresh.status(principal);
  }finally{await writer.query('ROLLBACK');writer.release();}
});

test('Replicas upgrades wait before acquiring dependent table locks and preserve the inventory writer',async t=>{
  const {db,fresh,appName}=await setup(t),writer=await db.pool.connect();
  await db.pool.query('ALTER TABLE opencrawl_replicas_workspace_inventories DROP COLUMN export_check');
  let startup;
  try {
    await writer.query('BEGIN');
    // Same order as an existing import step, including a worker from a previous release.
    await writer.query('SELECT state FROM opencrawl_replicas_imports WHERE namespace=$1 AND tenant=$2',[db.namespace,principal.tenantId]);
    await writer.query(`INSERT INTO opencrawl_replicas_workspace_inventories(namespace,tenant,import_id,workspace,checked_at,result)
      VALUES($1,$2,'import','workspace',now(),'ready')`,[db.namespace,principal.tenantId]);
    startup=fresh.status(principal);
    startup.catch(()=>{});
    const until=Date.now()+8_000;
    let waiting=false;
    while(!waiting && Date.now()<until) {
      const {rows}=await db.pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",[appName]);
      waiting=rows[0].waiting;
      if(!waiting)await pause(10);
    }
    assert.ok(waiting,'new adapter did not reach the active transaction');
    await writer.query('UPDATE opencrawl_replicas_deferred SET retry_at=now() WHERE namespace=$1 AND tenant=$2',[db.namespace,principal.tenantId]);
    await writer.query('COMMIT');
    await startup;
    const {rows}=await db.pool.query('SELECT result,export_check FROM opencrawl_replicas_workspace_inventories WHERE namespace=$1 AND tenant=$2',[db.namespace,principal.tenantId]);
    assert.deepEqual(rows,[{result:'ready',export_check:null}]);
  }finally{
    await writer.query('ROLLBACK');
    writer.release();
    await startup?.catch(()=>{});
  }
});
