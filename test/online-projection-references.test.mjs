import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createBoundObjectMigration,onlineProjectionValue} from '../dist/src/state/object-migration.mjs';
import {createOnlineProjection} from '../dist/src/state/online-projection.mjs';
import {createValueReports,encodeSavedValueReport} from '../dist/src/state/value-reports.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex'),encode=value=>Buffer.from(JSON.stringify(value));
const tenant='org_reference',prefix='sessions',org='00000000-0000-4000-8000-000000000001';
const alias=prefix+'/identity/replicas-v1/tenants/'+digest(tenant)+'/'+org+'.json',report=prefix+'/value/tenants/'+digest(tenant)+'.json';
function options(){return {database:{namespace:'synthetic',pool:{query:()=>assert.fail('No ambient pool access')},transaction:()=>assert.fail('No ambient transaction')},prefix,tenantIds:[tenant],store:{bucket:'synthetic',get:()=>assert.fail('No source dependency reads')},registryRecords:[],eventIdentities:{}};}
test('actual online decoder retains aliases only as scoped references, including deletion, without source reads',async()=>{
 const object=createBoundObjectMigration(options()),value={organizationId:org},decoded=object.decodeOnline(alias,encode(value));
 assert.deepEqual(decoded,{kind:'replicas-reference',domain:'replicas-index',identity:[digest(tenant),org],tenantHash:digest(tenant),organizationId:org,value});
 assert.equal(object.decodeOnline(alias,null).value,null);
 assert.throws(()=>object.decodeOnline(alias,encode({organizationId:randomUUID()})),/identity mismatch/);
 assert.throws(()=>object.decodeOnline(alias,encode({...value,tenantId:tenant})));
 assert.throws(()=>object.decodeOnline(alias.replace(digest(tenant),digest('org_other')),null),/owner hash/);
 await assert.rejects(object.projectOnlineIn({query:()=>assert.fail('Cannot mutate connection')},decoded),/cannot publish canonical/);
 await assert.rejects(object.readOnlineIn({query:()=>assert.fail('Cannot imply canonical parity')},decoded),/coordinator/);
});
test('value report decoder keeps historical objects bounded and distinct from physical deletion',()=>{
 const object=createBoundObjectMigration(options()),value={schema:0,historical:{measurement:'unknown'}};
 assert.deepEqual(onlineProjectionValue(object.decodeOnline(report,encode(value))),value);
 assert.equal(onlineProjectionValue(object.decodeOnline(report,null)),null);
 for(const invalid of [null,[],17,'report'])assert.throws(()=>object.decodeOnline(report,encode(invalid)));
 const exact={text:'x'.repeat(65525)};assert.equal(encode(exact).length,65536);assert.deepEqual(object.decodeOnline(report,encode(exact)).value,exact);
 assert.throws(()=>object.decodeOnline(report,encode({text:exact.text+'x'})),/supported migration limit/);
 assert.throws(()=>object.decodeOnline(report.replace(digest(tenant),digest('org_other')),null),/owner hash/);
});
test('value-report owner repository uses only supplied transaction client and namespace/hash on every effect',async()=>{
 const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return {rows:sql.startsWith('SELECT')?[{report:{schema:0}}]:[],rowCount:1};}},repo=createValueReports(options().database),owner=digest(tenant);
 await repo.projectIn(client,owner,{schema:0});assert.deepEqual(await repo.readIn(client,owner),{schema:0});await repo.projectIn(client,owner,null);
 assert.equal(calls.length,3);for(const call of calls){assert.deepEqual(call.args.slice(0,2),['synthetic',owner]);assert.doesNotMatch(call.sql,/BEGIN|COMMIT|CREATE|ALTER/);}
 const count=calls.length;await assert.rejects(repo.projectIn(client,'foreign',{}),/owner/);await assert.rejects(repo.projectIn(client,owner,[]),/Invalid saved/);await assert.rejects(repo.projectIn(client,owner,{text:'x'.repeat(65536)}),/Invalid saved/);assert.equal(calls.length,count);
});
test('value-report encoding does not turn unsupported historical measurements into runtime-supported reports',async()=>{
 const historical={schema:0,neverMeasured:true},base=options(),repo=createValueReports({...base.database,pool:{query:async()=>({rows:[{report:historical}]})}});
 assert.equal(encodeSavedValueReport(historical),JSON.stringify(historical));assert.deepEqual(await repo.exportReport(digest(tenant)),historical);assert.equal(await repo.read(tenant),null);
});
test('reference parity refuses ambient read committed or writable transactions and invalid page bounds before rows',async()=>{
 const base=options(),epoch=randomUUID(),projection=createOnlineProjection({...base,epoch,sourceId:'source',journalBinding:{namespace:base.database.namespace,epoch,sourceId:'source'},enrollment:{verifierId:'synthetic',initialReceiptHash:digest('scope'),verify:()=>assert.fail('No enrollment')}});
 for(const settings of [{isolation:'read committed',read_only:'on'},{isolation:'repeatable read',read_only:'off'}]){let calls=0;await assert.rejects(projection.inspectReplicasReferencesPageIn({query:async sql=>{calls++;assert.match(sql,/current_setting/);return {rows:[settings]};}}),/read-only repeatable/);assert.equal(calls,1);}
 for(const limit of [0,65,NaN,1.5])await assert.rejects(projection.inspectReplicasReferencesPageIn({query:()=>assert.fail('No SQL')},{limit}),/page bound/);
});
