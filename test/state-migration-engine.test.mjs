import {test} from 'node:test';
import assert from 'node:assert/strict';
import {migrateApplicationSources,migrationHash} from '../dist/src/state/migration-engine.mjs';
import {createValueReports} from '../dist/src/state/value-reports.mjs';
import {requireApplicationStateReady} from '../dist/src/state/postgres.mjs';
import {applicationDatabaseFixture,postgresUrl} from './fixtures/application-database.mjs';
const live=(name,fn)=>test(name,{skip:!postgresUrl},fn);
async function fixture(t){
  const database=await applicationDatabaseFixture(t),source={version:1,bucket:'hosted-source',prefix:'sessions/production/v1',organizationId:null};
  const reports=createValueReports(database);await reports.ready();
  const reportHash=migrationHash('org_fixture'),config={tenants:['org_fixture'],bucket:'hosted-source'};
  let value={version:1,retained:true},snapshots=0,writes=0,changedRead=false,changedListing=false,failFinalization=false;
  const descriptor=(key,domain,body)=>({key,domain,version:null,hash:migrationHash(JSON.stringify(body)),bytes:Buffer.byteLength(JSON.stringify(body))});
  const configEntry=descriptor('configuration','migration-input',config);
  const inputRead=()=>({source:config,target:config,rows:0});
  const reportRead=async body=>({source:body,target:await reports.exportReport(reportHash),rows:1});
  const options={database,source,checkAccess:async()=>{},boundInputs:[{key:configEntry.key,hash:configEntry.hash}],sources:async()=>({
    async *inventory(){
      snapshots++;yield {entry:configEntry,readback:inputRead(),legacy:false};
      yield {retainedKey:changedListing&&snapshots>1?'raw/changed':'raw/original',legacy:true};
      yield {entry:descriptor('legacy:report','value-report',value),readback:await reportRead(value),legacy:true,mutableObject:true};
    },
    async validateInventory(){},
    async read(entry){
      if(entry.key==='configuration')return {entry:configEntry,readback:inputRead(),migrate:async()=>inputRead()};
      const body=changedRead?{version:2,retained:false}:value;
      return {entry:descriptor('legacy:report','value-report',body),readback:await reportRead(body),migrate:async()=>{writes++;await reports.importReport(reportHash,body);return reportRead(body);}};
    },
    async finalize(client){
      await client.query('UPDATE opencrawl_application_installations SET verified_at=now() WHERE namespace=$1',[database.namespace]);
      if(failFinalization)throw new Error('Final lifecycle transaction failed');
      return {lifecycle:{queued:0}};
    },
  })};
  return {database,options,configEntry,reports,reportHash,run:(mode,extra={})=>migrateApplicationSources({...options,mode,...extra}),writes:()=>writes,
    changeRead:()=>{changedRead=true;},changeListing:()=>{changedListing=true;},failFinalization:()=>{failFinalization=true;}};
}

live('shared engine binds reviewed multi-tenant input even after readiness without replaying old sources',async t=>{
  const f=await fixture(t);assert.equal((await f.run('check')).requiresStoppedWriters,true);
  await assert.rejects(f.run('migrate'),/writers-stopped/);
  const result=await f.run('migrate',{writersStopped:true});assert.equal(result.ready,true);assert.equal(result.sources,2);assert.equal(f.writes(),1);
  await requireApplicationStateReady(f.database);
  const noLegacy={sources:async()=>{throw new Error('Ready rerun must not open old source');}};
  assert.equal((await f.run('verify',noLegacy)).alreadyReady,true);
  await assert.rejects(f.run('verify',{...noLegacy,boundInputs:[{key:f.configEntry.key,hash:migrationHash('changed config')}]}),/Reviewed migration input differs/);
  assert.equal(f.writes(),1);
});

live('shared engine rejects changed source hashes before invoking any typed write',async t=>{
  const f=await fixture(t);f.changeRead();
  await assert.rejects(f.run('migrate',{writersStopped:true}),/Source changed after inventory/);
  assert.equal(f.writes(),0);assert.equal(await f.reports.exportReport(f.reportHash),null);
  await assert.rejects(requireApplicationStateReady(f.database));
  const saved=(await f.database.pool.query('SELECT state,inventory_complete FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0];
  assert.deepEqual(saved,{state:'importing',inventory_complete:true});
});

live('shared engine requires the complete immutable inventory and rolls back lifecycle readiness together',async t=>{
  const altered=await fixture(t);altered.changeListing();
  await assert.rejects(altered.run('migrate',{writersStopped:true}),/inventory changed/);await assert.rejects(requireApplicationStateReady(altered.database));
  const failed=await fixture(t);failed.failFinalization();
  await assert.rejects(failed.run('migrate',{writersStopped:true}),/Final lifecycle transaction failed/);
  const saved=(await failed.database.pool.query('SELECT state,verified_at FROM opencrawl_application_installations WHERE namespace=$1',[failed.database.namespace])).rows[0];
  assert.deepEqual(saved,{state:'importing',verified_at:null});await assert.rejects(requireApplicationStateReady(failed.database));
});


live('expected backup manifest rejects source drift before any installation row and stays bound after readiness',async t=>{
 const f=await fixture(t),checked=await f.run('check');
 await assert.rejects(f.run('migrate',{writersStopped:true,expectedManifest:'not-a-sha256'}),/Invalid expected migration manifest/);
 await assert.rejects(f.run('migrate',{writersStopped:true,expectedManifest:migrationHash('different snapshot')}),/differs from the retained backup/);
 assert.equal(f.writes(),0);
 assert.equal((await f.database.pool.query('SELECT count(*)::int n FROM opencrawl_application_installations WHERE namespace=$1',[f.database.namespace])).rows[0].n,0);
 await f.run('migrate',{writersStopped:true,expectedManifest:checked.manifest});
 assert.equal((await f.run('verify',{expectedManifest:checked.manifest})).alreadyReady,true);
 await assert.rejects(f.run('verify',{expectedManifest:migrationHash('changed recovery point')}),/differs from the retained backup/);
});
