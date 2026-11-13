import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshDevelopmentRoutes,routeUrl,routeManifest} from '../dev/airbyte-routes.mts';
const record={tenantId:'org_test',userId:'user_test',environment:'selfhost',integrationId:'int_'+'a'.repeat(26),provider:'granola',scope:'team',status:'active',airbyteLandingMode:'operator-owned',airbyteWorkspaceId:'workspace',s3Bucket:'owned-bucket',s3Prefix:'raw/v1/source=granola/workspace=org_test/connection=int_'+'a'.repeat(26),airbyte:{destinationId:'destination',sourceId:'source'},account:'Synthetic development sample — not a Granola account'};
function fixture(records=[record]){
 const resources={
  '/destinations/destination':{workspaceId:'workspace',destinationId:'destination',configuration:{s3_bucket_name:record.s3Bucket,s3_bucket_path:record.s3Prefix,s3_endpoint:'http://172.18.0.3:8333',secret_access_key:'preserved-secret',format:{format_type:'JSONL'}}},
  '/sources/source':{workspaceId:'workspace',sourceId:'source',configuration:{base_url:'http://172.18.0.5:8080',other:'retained'}},
 };
 const writes=[],reads=[];
 const options={organizationId:'org_test',workspaceId:'workspace',bucket:'owned-bucket',registry:{listTenant:async()=>records},transport:{request:async(method,path,body)=>{
  assert.ok(resources[path]);if(method==='GET'){reads.push(path);return structuredClone(resources[path]);}
  assert.equal(method,'PATCH');writes.push({path,body});Object.assign(resources[path].configuration,body.configuration);return structuredClone(resources[path]);
 }}};
 return {options,resources,writes,reads};
}
test('development route migration changes only owned endpoints and is idempotent',async()=>{
 const f=fixture();assert.deepEqual(await refreshDevelopmentRoutes(f.options),{routesRefreshed:2});
 assert.deepEqual(f.writes,[{path:'/destinations/destination',body:{configuration:{s3_endpoint:routeUrl('s3')}}},{path:'/sources/source',body:{configuration:{base_url:routeUrl('fixture')}}}]);
 assert.equal(f.resources['/destinations/destination'].configuration.secret_access_key,'preserved-secret');
 assert.deepEqual(f.resources['/destinations/destination'].configuration.format,{format_type:'JSONL'});
 assert.equal(f.resources['/sources/source'].configuration.other,'retained');
 assert.deepEqual(await refreshDevelopmentRoutes(f.options),{routesRefreshed:0});
});
test('route ownership is checked across the whole plan before changing any connector',async()=>{
 const f=fixture();f.resources['/sources/source'].workspaceId='foreign';
 await assert.rejects(refreshDevelopmentRoutes(f.options),/ownership mismatch/);assert.equal(f.writes.length,0);
 const g=fixture();g.resources['/destinations/destination'].configuration.s3_bucket_path='foreign-data';
 await assert.rejects(refreshDevelopmentRoutes(g.options),/ownership mismatch/);assert.equal(g.writes.length,0);
});
test('normal provider sources are not changed by development storage routing',async()=>{
 const f=fixture([{...record,account:'A real provider account'}]);
 assert.deepEqual(await refreshDevelopmentRoutes(f.options),{routesRefreshed:1});
 assert.ok(!f.reads.some(path=>path.startsWith('/sources/')));
});
test('recovery routes preserve the service names while replacing only their private addresses',()=>{
 const manifest=routeManifest({app:'172.18.0.4',s3:'172.18.0.3',fixture:'172.18.0.5'});
 assert.deepEqual(manifest.items.filter(item=>item.kind==='Service').map(item=>item.metadata.name),['opencrawl-app','opencrawl-storage','opencrawl-fixture']);
 assert.deepEqual(manifest.items.filter(item=>item.kind==='EndpointSlice').map(item=>item.endpoints[0].addresses[0]),['172.18.0.4','172.18.0.3','172.18.0.5']);
 assert.throws(()=>routeManifest({s3:'outside.example'}),/Invalid owned/);
});
