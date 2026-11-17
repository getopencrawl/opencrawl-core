import {isDeepStrictEqual} from 'node:util';
import type {ApplicationDatabase} from './postgres.mjs';

export async function prepareScopedState(database:ApplicationDatabase){
  await database.ready();
  await database.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:scoped-state:schema',0))");
    await client.query(`CREATE TABLE IF NOT EXISTS opencrawl_scoped_installations (
      namespace text PRIMARY KEY, source_identity jsonb NOT NULL, source_hash text NOT NULL,
      state text NOT NULL CHECK(state IN ('importing','ready')), verified_at timestamptz,
      CHECK(state<>'ready' OR verified_at IS NOT NULL))`);
  });
}
export async function requireScopedState(database:ApplicationDatabase){
  const full=await database.pool.query('SELECT state FROM opencrawl_application_installations WHERE namespace=$1',[database.namespace]);
  if(full.rows.length)throw new Error('This installation used the retired whole-application migration. Keep its existing release and restore its verified recovery point before adopting the scoped-state release.');
  const {rows}=await database.pool.query('SELECT source_identity,state FROM opencrawl_scoped_installations WHERE namespace=$1',[database.namespace]);
  if(rows.length!==1||rows[0].state!=='ready'||!isDeepStrictEqual(rows[0].source_identity,database.sourceIdentity))throw new Error('Verified scoped-state initialization is required before starting writers');
}
