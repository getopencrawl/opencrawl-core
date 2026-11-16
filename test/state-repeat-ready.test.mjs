import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase,ensureSchemaIndex} from '../dist/src/state/postgres.mjs';
import {ensureRegistrySchema} from '../dist/src/integrations/local-registry.mjs';
import {createIntegrationCommands} from '../dist/src/state/integration-commands.mjs';
import {createPostgresBoardState} from '../dist/src/state/board.mjs';
import {createReplicasState} from '../dist/src/state/replicas.mjs';
import {createDevinState} from '../dist/src/state/devin.mjs';
import {ensureWriteBarrierSchema} from '../dist/src/state/write-barriers.mjs';
import {createSearchContextJobs} from '../dist/src/state/search-context-jobs.mjs';
import {createSearchContextContinuations} from '../dist/src/state/search-context-continuations.mjs';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';
import {postgresUrl,dropTestSchemas} from './fixtures/application-database.mjs';

const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
const source={version:1,bucket:'ready-fixture',prefix:'sessions/production/v1',organizationId:null};
const binding={environment:'production',bucket:source.bucket,prefix:source.prefix,endpoint:'https://search.fixture.invalid',generation:'v1'};
const indexed=['opencrawl_integrations_owner','opencrawl_integration_commands_pending','opencrawl_board_messages_topic','opencrawl_board_messages_publication','opencrawl_board_messages_mentions','opencrawl_board_search_words','opencrawl_board_participants_name','opencrawl_board_participants_seen','opencrawl_board_search_snapshots_expiry','opencrawl_replicas_connections_tenant','opencrawl_devin_connections_tenant','opencrawl_resource_writers_pending','opencrawl_search_context_pending','opencrawl_search_context_continuation_pending','opencrawl_event_identity_resource'];
async function fixture(t){
 const admin=new Pool({connectionString:postgresUrl,max:1}),schema='oc_ready_'+randomUUID().replaceAll('-',''),namespace='ready-'+randomUUID();
 await admin.query(`CREATE SCHEMA ${schema}`);
 const config={connectionString:postgresUrl,namespace,sourceIdentity:source,options:'-c search_path='+schema+' -c lock_timeout=400ms',max:3};
 const database=createApplicationDatabase(config);await database.ready();
 await database.pool.query("INSERT INTO opencrawl_application_installations(namespace,source_identity,migration_id,state,verified_at,inventory_complete) VALUES($1,$2,$3,'ready',now(),true)",[namespace,source,randomUUID()]);
 t.after(async()=>{await database.close();try{await dropTestSchemas(admin,[schema,database.identitySchema]);}finally{await admin.end();}});
 return {database,schema,config};
}
async function allReady(database,config){
 await database.ready();await ensureRegistrySchema(database);
 await createIntegrationCommands({database,environment:'production',encryptionKey:Buffer.alloc(32,1)}).ready();
 await createPostgresBoardState(database).ready();await createReplicasState(database).ready();await createDevinState(database).ready();await ensureWriteBarrierSchema(database);
 await createSearchContextJobs({database,binding}).ready();await createSearchContextContinuations({database,binding}).ready();
 const identities=createPostgresEventIdentities(config);try{await identities.ready();}finally{await identities.close();}
}
async function catalog(database){return (await database.pool.query("SELECT c.relname,c.relfilenode,pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='i' ORDER BY c.relname")).rows;}

live('all installed ready paths avoid strong table DDL locks while writers hold their tables',async t=>{
 const {database,config}=await fixture(t);await allReady(database,config);const before=await catalog(database);
 const tables=(await database.pool.query("SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'opencrawl_%' ORDER BY tablename")).rows.map(r=>r.tablename);
 const writer=await database.pool.connect(),fresh=createApplicationDatabase(config);
 try{
  await writer.query('BEGIN');await writer.query(`LOCK TABLE ${tables.join(',')} IN ROW EXCLUSIVE MODE`);
  await allReady(fresh,config);
  assert.deepEqual(await catalog(database),before,'No installed index was recreated or changed');
 }finally{await writer.query('ROLLBACK');writer.release();await fresh.close();}
});

live('known legacy columns, operation check and missing indexes upgrade once without discarding rows',async t=>{
 const {database,config}=await fixture(t);await allReady(database,config);
 await database.pool.query("INSERT INTO opencrawl_integration_bindings VALUES($1,'org_fixture','production',null)",[database.namespace]);
 await database.pool.query("INSERT INTO opencrawl_integration_commands(namespace,environment,tenant_id,user_id,integration_id,command_id,requested_by,operation,status) VALUES($1,'production','org_fixture','user_fixture','int_fixture','cmd_fixture','user_fixture','sync','pending')",[database.namespace]);
 const original=(await database.pool.query('SELECT * FROM opencrawl_integration_commands')).rows;
 await database.pool.query(`ALTER TABLE opencrawl_application_installations DROP COLUMN inventory_complete;
 ALTER TABLE opencrawl_integration_bindings DROP COLUMN binding_id, ALTER COLUMN organization_id SET NOT NULL;
 ALTER TABLE opencrawl_search_context_jobs DROP COLUMN continuation_id;
 ALTER TABLE opencrawl_integration_commands DROP CONSTRAINT opencrawl_integration_commands_operation_check,ADD CONSTRAINT opencrawl_integration_commands_operation_check CHECK(operation IN ('provision','disconnect','sync'));
 ${indexed.map(name=>'DROP INDEX '+name).join(';')}`);
 const fresh=createApplicationDatabase(config);try{await allReady(fresh,config);}finally{await fresh.close();}
 assert.deepEqual((await database.pool.query('SELECT * FROM opencrawl_integration_commands')).rows,original);
 assert.deepEqual((await database.pool.query('SELECT organization_id,binding_id FROM opencrawl_integration_bindings')).rows,[{organization_id:'org_fixture',binding_id:null}]);
 assert.equal((await database.pool.query('SELECT inventory_complete FROM opencrawl_application_installations')).rows[0].inventory_complete,false);
 assert.equal((await database.pool.query('SELECT count(*)::int n FROM pg_indexes WHERE schemaname=current_schema() AND indexname=ANY($1)',[indexed])).rows[0].n,indexed.length);
 await database.pool.query("UPDATE opencrawl_integration_commands SET operation='consent'");
 await assert.rejects(database.pool.query("UPDATE opencrawl_integration_commands SET operation='unrecognized'"),{code:'23514'});
});

live('existing incompatible upgrade columns and command checks fail without replacing them',async t=>{
 const {database,config}=await fixture(t);await allReady(database,config);
 const cases=[
  ["ALTER TABLE opencrawl_application_installations ALTER COLUMN inventory_complete DROP NOT NULL",db=>db.ready(),/inventory column/,"ALTER TABLE opencrawl_application_installations ALTER COLUMN inventory_complete SET NOT NULL"],
  ["ALTER TABLE opencrawl_integration_bindings ALTER COLUMN binding_id TYPE integer USING null",db=>ensureRegistrySchema(db),/binding schema/,"ALTER TABLE opencrawl_integration_bindings ALTER COLUMN binding_id TYPE text USING null"],
  ["ALTER TABLE opencrawl_search_context_jobs ALTER COLUMN continuation_id TYPE text USING continuation_id::text",db=>createSearchContextJobs({database:db,binding}).ready(),/continuation column/,"ALTER TABLE opencrawl_search_context_jobs ALTER COLUMN continuation_id TYPE uuid USING continuation_id::uuid"],
  ["ALTER TABLE opencrawl_integration_commands DROP CONSTRAINT opencrawl_integration_commands_operation_check, ADD CONSTRAINT opencrawl_integration_commands_operation_check CHECK(operation<>'forbidden')",db=>createIntegrationCommands({database:db,environment:'production',encryptionKey:Buffer.alloc(32,1)}).ready(),/operation constraint/,"ALTER TABLE opencrawl_integration_commands DROP CONSTRAINT opencrawl_integration_commands_operation_check, ADD CONSTRAINT opencrawl_integration_commands_operation_check CHECK(operation IN ('provision','disconnect','sync','consent'))"],
 ];
 for(const [breakSchema,prepare,expected,repair] of cases){await database.pool.query(breakSchema);const fresh=createApplicationDatabase(config);try{await assert.rejects(prepare(fresh),expected);}finally{await fresh.close();await database.pool.query(repair);}}
});

live('index catalog guard accepts exact partial expression GIN and descending indexes but rejects substitutions',async t=>{
 const {database,schema}=await fixture(t);
 await database.pool.query('CREATE TABLE shape_table(namespace text,status text,name text,seen bigint,record jsonb,words tsvector,actor text); CREATE TABLE other_table(namespace text,status text)');
 await database.pool.query(`CREATE FUNCTION ${schema}.lower(text) RETURNS text LANGUAGE SQL IMMUTABLE AS 'SELECT upper($1)'`);
 const definitions=[
  {table:'shape_table',name:'shape_plain',keys:['namespace','seen DESC']},
  {table:'shape_table',name:'shape_lower',keys:['lower(name)']},
  {table:'shape_table',name:'shape_json',method:'gin',keys:["((record -> 'mentions'::text))"]},
  {table:'shape_table',name:'shape_words',method:'gin',keys:['words']},
  {table:'shape_table',name:'shape_partial',keys:['namespace'],predicate:{column:'status',equals:'creating',notNull:'actor'}},
 ];
 for(const definition of definitions)await database.transaction(async c=>{await ensureSchemaIndex(c,definition);await ensureSchemaIndex(c,definition);});
 const replacements=[
  ['shape_plain','CREATE INDEX shape_plain ON shape_table(namespace text_pattern_ops,seen DESC)'],
  ['shape_plain','CREATE INDEX shape_plain ON shape_table(namespace COLLATE "C",seen DESC)'],
  ['shape_plain','CREATE INDEX shape_plain ON shape_table(namespace,seen)'],
  ['shape_plain','CREATE INDEX shape_plain ON shape_table(namespace,seen DESC) INCLUDE(status)'],
  ['shape_plain','CREATE UNIQUE INDEX shape_plain ON shape_table(namespace,seen DESC)'],
  ['shape_plain','CREATE INDEX shape_plain ON other_table(namespace,status)'],
  ['shape_lower','CREATE INDEX shape_lower ON shape_table(upper(name))'],
  ['shape_lower',`CREATE INDEX shape_lower ON shape_table(${schema}.lower(name))`],
  ['shape_json',"CREATE INDEX shape_json ON shape_table USING gin((record->'other'))"],
  ['shape_json',"CREATE INDEX shape_json ON shape_table USING gin((record->'mentions') jsonb_path_ops)"],
  ['shape_partial',"CREATE INDEX shape_partial ON shape_table(namespace) WHERE status='creating'"],
  ['shape_plain','CREATE TABLE shape_plain(value text)'],
 ];
 for(const [name,sql] of replacements){
  await database.pool.query('DROP INDEX '+name+'; '+sql);
  const definition=definitions.find(x=>x.name===name);
  await assert.rejects(database.transaction(c=>ensureSchemaIndex(c,definition)),/Existing schema index is incompatible/);
  await database.pool.query((sql.startsWith('CREATE TABLE')?'DROP TABLE ':'DROP INDEX ')+name);
  await database.transaction(c=>ensureSchemaIndex(c,definition));
 }
 await assert.rejects(database.transaction(async c=>{
  await c.query(`SET LOCAL search_path=${schema},pg_catalog`);
  await ensureSchemaIndex(c,{table:'shape_table',name:'shape_missing',keys:['lower(name)']});
 }),/Existing schema index is incompatible/);
 assert.equal((await database.pool.query("SELECT to_regclass(current_schema()||'.shape_missing') AS index")).rows[0].index,null,'An incompatible newly created index rolls back');
});
