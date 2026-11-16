import {randomUUID} from 'node:crypto';
import {createApplicationDatabase} from '../../dist/src/state/postgres.mjs';

export const postgresUrl=process.env.OPENCRAWL_TEST_POSTGRES_URL;
/** Every test gets its own logical installation. Never clean by database name or
 * global table truncation: tests may run concurrently on a shared PostgreSQL. */
export async function applicationDatabaseFixture(t,{namespace='test-'+randomUUID(),...options}={}){
  if(!postgresUrl)throw new Error('Set OPENCRAWL_TEST_POSTGRES_URL for PostgreSQL application tests');
  const database=createApplicationDatabase({connectionString:postgresUrl,namespace,...options});
  await database.ready();
  t.after(async()=>{
    try {
      const {rows}=await database.pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='namespace' AND table_name LIKE 'opencrawl_%'");
      // Parent-first FK dependencies are cleared with cascade at row level; a
      // deferred second pass handles a child table discovered after its parent.
      const tables=rows.map(row=>row.table_name).filter(name=>/^opencrawl_[a-z_]+$/.test(name));
      const maxPasses=tables.length+1;
      for(let pass=0;tables.length&&pass<maxPasses;pass++){
        for(let i=tables.length-1;i>=0;i--){try{await database.pool.query(`DELETE FROM "${tables[i]}" WHERE namespace=$1`,[namespace]);tables.splice(i,1);}catch(error){if(error.code!=='23503')throw error;}}
      }
      if(tables.length)throw new Error('Test database cleanup has unresolved table dependencies');
      await database.transaction(async client=>{
        // Better Auth's native schema introspection visits every visible schema.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");
        await client.query(`DROP SCHEMA "${database.identitySchema}" CASCADE`);
      });
    }finally{await database.close();}
  });
  return database;
}
