import pg from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {createPostgresEventIdentities} from '../dist/src/sessions/postgres-identities.mjs';

const password=process.env.OPENCRAWL_DATABASE_PASSWORD;
const config={user:'opencrawl',password,database:'opencrawl'};
const source=new pg.Client({...config,host:'app-db'}),target=new pg.Client({...config,host:'temporal-db'});
const tables=[
 ['opencrawl_event_identity_schema',['singleton','version','database_id'],'singleton'],
 ['opencrawl_event_identity_sessions',['id','namespace','source','identity','resource','state','event_count'],'id'],
 ['opencrawl_event_identities',['session_id','event_hash','content_hash'],'session_id,event_hash'],
 ['opencrawl_event_identity_deletions',['namespace','resource'],'namespace,resource'],
];
const schema=createPostgresEventIdentities({...config,host:'temporal-db',namespace:'upgrade-schema-only'});
await schema.ready();await schema.close();
async function scan(client,table,columns,order,consume=async()=>{}) {
 const hash=createHash('sha256');let count=0;
 await client.query(`DECLARE transfer_rows NO SCROLL CURSOR FOR SELECT ${columns.join(',')} FROM ${table} ORDER BY ${order}`);
 try {for(;;){const {rows}=await client.query('FETCH 5000 FROM transfer_rows');if(!rows.length)break;
  for(const row of rows){hash.update(JSON.stringify(row)+'\n');count++;}await consume(rows);
 }}finally{await client.query('CLOSE transfer_rows');}
 return {count,sha256:hash.digest('hex')};
}
try {
 // pg.Client cannot reconnect after a failed connect; wait with short-lived probes.
 for(let attempt=0;;attempt++) {
  const probe=new pg.Client({...config,host:'app-db',connectionTimeoutMillis:2000});
  try{await probe.connect();break;}catch(error){if(attempt>=59)throw error;await delay(1000);}finally{await probe.end();}
 }
 await source.connect();await target.connect();
 await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await target.query('BEGIN');
 await target.query("SELECT pg_advisory_xact_lock(hashtext('opencrawl-database-transfer'))");
 const actual=(await source.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
 if(JSON.stringify(actual)!==JSON.stringify(tables.map(t=>t[0]).sort()))throw new Error('Unexpected legacy database tables; preserve stores for a reviewed migration');
 const sourceId=(await source.query('SELECT database_id FROM opencrawl_event_identity_schema WHERE singleton')).rows[0]?.database_id;
 if(!sourceId)throw new Error('Legacy identity database has no identity');
 const targetId=(await target.query('SELECT database_id FROM opencrawl_event_identity_schema WHERE singleton')).rows[0]?.database_id;
 const copied=sourceId===targetId,receipt=[];
 if(!copied) {
  for(const [table] of tables.slice(1))if((await target.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)throw new Error('Destination database already contains another installation');
  await target.query('DELETE FROM opencrawl_event_identity_schema');
 }
 for(const [table,columns,order] of tables) {
  const expected=await scan(source,table,columns,order,async rows=>{
   if(copied)return;
   const values=rows.flatMap(row=>columns.map(c=>row[c]));
   const placeholders=rows.map((_,r)=>'('+columns.map((_,c)=>'$'+(r*columns.length+c+1)).join(',')+')').join(',');
   await target.query(`INSERT INTO ${table} (${columns.join(',')}) ${table==='opencrawl_event_identity_sessions'?'OVERRIDING SYSTEM VALUE ':''}VALUES ${placeholders}`,values);
  });
  const result=await scan(target,table,columns,order);
  if(JSON.stringify(expected)!==JSON.stringify(result))throw new Error('Database transfer verification failed');
  receipt.push({table,...result});
 }
 await target.query("SELECT setval(pg_get_serial_sequence('opencrawl_event_identity_sessions','id'), COALESCE(MAX(id),1), MAX(id) IS NOT NULL) FROM opencrawl_event_identity_sessions");
 await target.query('COMMIT');await source.query('COMMIT');
 console.log(JSON.stringify({databaseTransferred:true,databaseId:sourceId,reused:copied,tables:receipt}));
} catch(error) {
 await target.query('ROLLBACK').catch(()=>{});await source.query('ROLLBACK').catch(()=>{});
 // Driver errors may contain connection details; the operator gets a bounded reason.
 console.error(error instanceof Error&&/^(Unexpected|Legacy|Destination|Database transfer)/.test(error.message)?error.message:'Database transfer failed; retain recovery files and rerun the upgrade.');process.exitCode=1;
} finally {await source.end();await target.end();}
