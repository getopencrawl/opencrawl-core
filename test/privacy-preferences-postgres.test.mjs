import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApplicationDatabase} from '../dist/src/state/postgres.mjs';
import {preparePrivacyPreferences,postgresPrivacyPreferenceRepository} from '../dist/src/state/privacy-preferences.mjs';
import {privacyPreferences} from '../dist/src/sessions/privacy.mjs';

const connectionString=process.env.OPENCRAWL_TEST_POSTGRES_URL;
test('privacy preferences preserve revisions, isolate owners and serialize competing edits in PostgreSQL',{skip:!connectionString},async t=>{
  const database=createApplicationDatabase({connectionString,namespace:randomUUID()});
  const outside=database.namespace+'-other';
  t.after(async()=>{
    try {await database.pool.query('DELETE FROM opencrawl_privacy_preferences WHERE namespace=ANY($1)',[[database.namespace,outside]]);}
    finally {await database.close();}
  });
  await preparePrivacyPreferences(database);
  const repo=postgresPrivacyPreferenceRepository(database.pool,database.namespace);
  const service=privacyPreferences(repo,p=>p.userId!=='denied');
  const owner={tenantId:'one',userId:'a'},other={tenantId:'two',userId:'a'};
  const defaults=await service.read(owner);
  assert.equal(defaults.revision,'0');
  await assert.rejects(service.change(other,defaults),{status:409});
  await assert.rejects(service.read({...owner,userId:'denied'}),{status:404});
  const retained={enabled:false,rules:'preserve rules',revision:randomUUID()};
  assert.equal(await repo.replace(defaults.subject,'0',retained),true);
  assert.deepEqual(await service.read(owner),{...retained,subject:defaults.subject});
  for(const principal of [other,{...owner,userId:'b'}])assert.equal((await service.read(principal)).revision,'0');
  assert.equal(await postgresPrivacyPreferenceRepository(database.pool,outside).read(defaults.subject),null);
  await assert.rejects(repo.read('one/a'),/subject/);
  const update={...retained,subject:defaults.subject};
  const race=await Promise.allSettled(['one','two'].map(rules=>service.change(owner,{...update,rules})));
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(race.find(r=>r.status==='rejected').reason.status,409);
  const winner=race.find(r=>r.status==='fulfilled').value;
  assert.deepEqual(await service.read(owner),winner);
  const escaped={enabled:true,rules:'nul\0 and lone \ud800',revision:'old\udcffrevision'};
  assert.equal(await repo.replace(defaults.subject,winner.revision,escaped),true);
  assert.deepEqual(await repo.read(defaults.subject),escaped);
  assert.equal(await repo.replace(defaults.subject,'old\ufffdrevision',retained),false);
  assert.equal(await repo.replace(defaults.subject,escaped.revision,retained),true);
  assert.deepEqual(await repo.read(defaults.subject),retained);
  const initial=await service.read(other);
  const creates=await Promise.allSettled([true,false].map(enabled=>service.change(other,{...initial,enabled})));
  assert.equal(creates.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(creates.find(r=>r.status==='rejected').reason.status,409);
});
