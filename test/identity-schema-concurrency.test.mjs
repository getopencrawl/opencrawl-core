import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
import {createLocalIdentity} from '../dist/src/identity/better-auth.mjs';

test('identity schema initialization coordinates with retirement of unrelated namespaces',{skip:!postgresUrl},async t=>{
  const database=await applicationDatabaseFixture(t),other=await applicationDatabaseFixture(t);
  const options={url:'https://identity.example.test',secret:randomBytes(32).toString('hex'),organizationId:'org_concurrent',database};
  const retirement=async()=>{for(let i=0;i<12;i++)await other.transaction(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('opencrawl:identity-schema:maintenance',0))");
    const schema='retiring_'+randomBytes(8).toString('hex');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`CREATE TABLE "${schema}".retired(id serial PRIMARY KEY)`);
    await client.query(`DROP SCHEMA "${schema}" CASCADE`);
  });};
  const identities=await Promise.all([retirement(),...Array.from({length:4},()=>createLocalIdentity(options))]);
  for(const identity of identities.slice(1)){await identity.ready();assert.equal(await identity.setupRequired(),true);}
  const schemas=await database.pool.query('SELECT table_schema FROM information_schema.tables WHERE table_schema=$1',[database.identitySchema]);assert.ok(schemas.rows.length>10);
});
