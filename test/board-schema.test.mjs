import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createApplicationDatabase,ensureSchemaIndex} from '../dist/src/state/postgres.mjs';
import {createPostgresBoardState} from '../dist/src/state/board.mjs';
import {postgresUrl,dropTestSchemas} from './fixtures/application-database.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
async function fixture(t){
 const admin=new Pool({connectionString:postgresUrl,max:1}),schema='oc_ready_'+randomUUID().replaceAll('-',''),namespace='ready-'+randomUUID();
 await admin.query(`CREATE SCHEMA ${schema}`);
 const config={connectionString:postgresUrl,namespace,options:'-c search_path='+schema+' -c lock_timeout=400ms',max:3};
 const database=createApplicationDatabase(config);await database.ready();
 t.after(async()=>{await database.close();try{await dropTestSchemas(admin,[schema,database.identitySchema]);}finally{await admin.end();}});
 return {database,schema,config};
}

live('board schema upgrades only the missing reply index and repeated startup preserves writer access',async t=>{
 const {database,config}=await fixture(t),repository=createPostgresBoardState(database);await repository.ready();
 await repository.importLegacy('a'.repeat(64),{schema:1,messages:[{id:1,timestamp:1,agent:'writer',author:'owner',name:'Writer',topic:'work',text:'Retained root',requestId:'root'},{id:2,timestamp:2,agent:'writer',author:'owner',name:'Writer',topic:'work',threadId:1,text:'Retained reply',requestId:'reply'}],agents:{},usage:{calls:0,inputBytes:0,outputBytes:0}});
 const original=await repository.exportLegacy('a'.repeat(64));
 await database.pool.query('DROP INDEX opencrawl_board_messages_thread');
 const fresh=createApplicationDatabase(config);try{await createPostgresBoardState(fresh).ready();}finally{await fresh.close();}
 assert.deepEqual(await repository.exportLegacy('a'.repeat(64)),original);
 const before=(await database.pool.query("SELECT oid,relfilenode FROM pg_class WHERE oid=to_regclass('opencrawl_board_messages_thread')")).rows;
 const writer=await database.pool.connect(),next=createApplicationDatabase(config);
 try{
  await writer.query('BEGIN');await writer.query('LOCK TABLE opencrawl_board_messages IN ROW EXCLUSIVE MODE');
  await createPostgresBoardState(next).ready();
  assert.deepEqual((await database.pool.query("SELECT oid,relfilenode FROM pg_class WHERE oid=to_regclass('opencrawl_board_messages_thread')")).rows,before);
 }finally{await writer.query('ROLLBACK');writer.release();await next.close();}
});
live('index catalog guard accepts exact partial expression GIN and descending indexes but rejects substitutions',async t=>{
 const {database,schema}=await fixture(t);
 await database.pool.query('CREATE TABLE shape_table(namespace text,status text,name text,seen bigint,record jsonb,words tsvector,actor text); CREATE TABLE other_table(namespace text,status text)');
 await database.pool.query(`CREATE FUNCTION ${schema}.lower(text) RETURNS text LANGUAGE SQL IMMUTABLE AS 'SELECT upper($1)'`);
 const definitions=[
  {table:'shape_table',name:'shape_plain',keys:['namespace','seen DESC']},
  {table:'shape_table',name:'shape_lower',keys:['lower(name)']},
  {table:'shape_table',name:'shape_json',method:'gin',keys:["((record -> 'mentions'::text))"]},
  {table:'shape_table',name:'shape_thread',keys:["(((record ->> 'threadId'::text))::bigint)"],jsonKey:{column:'record',key:'threadId'}},
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
  ['shape_thread',"CREATE INDEX shape_thread ON shape_table(((record->>'other')::bigint))"],
  ['shape_thread',"CREATE INDEX shape_thread ON shape_table(((record->>'threadId')::bigint))"],
  ['shape_thread',"CREATE INDEX shape_thread ON shape_table(((record->>'threadId')::bigint)) WHERE record ? 'other'"],
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
