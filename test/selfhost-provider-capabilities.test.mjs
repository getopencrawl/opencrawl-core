import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selfhostProviderCapabilities} from '../dist/src/selfhost/provider-capabilities.mjs';
import {createProviderCatalog} from '../dist/src/integrations/providers.mjs';

const definitions=Object.fromEntries(['slack','googledrive','notion','circleback','granola','linear','github'].map(id=>[id,{name:id}]));

test('the supported self-host runtime enables the Drive and Linear adapters',()=>{
 assert.deepEqual(selfhostProviderCapabilities,{driveWorkspaceAccess:true,linearPublicAccess:true});
 const providers=createProviderCatalog(definitions,selfhostProviderCapabilities);
 for(const id of ['googledrive','linear']){
  assert.equal(providers[id].unavailableReason,undefined,`${id} must not be unavailable in self-host`);
  assert.ok(providers[id].connector,`${id} must have its source adapter`);
 }
});

test('older runtime adapters still fail closed for Drive and Linear',()=>{
 const providers=createProviderCatalog(definitions);
 for(const id of ['googledrive','linear'])assert.match(providers[id].unavailableReason,/permission adapter/);
});

test('every self-host provider catalog uses the shared capability set',async()=>{
 const source=await readFile(new URL('../src/selfhost/services.mts',import.meta.url),'utf8');
 const builds=source.match(/createProviderCatalog\([^)]*\)/g)??[];
 assert.equal(builds.length,2,'both the Airbyte-disabled and enabled service paths build a catalog');
 assert.ok(builds.every(call=>call.includes('selfhostProviderCapabilities')),builds.join('\n'));
 assert.doesNotMatch(source,/driveWorkspaceAccess\s*:\s*true|linearPublicAccess\s*:\s*true/);
});

test('self-host docs describe Drive and Linear as available sources',async()=>{
 const docs=await readFile(new URL('../docs/self-host.md',import.meta.url),'utf8');
 const section=docs.split('## Connect sources')[1]?.split('\n## ')[0]??'';
 assert.match(section,/Google Drive/);
 assert.match(section,/Linear/);
 assert.match(section,/available for new connections/);
 assert.doesNotMatch(section,/Google Drive is\s+visible with an explicit unavailable notice/);
 assert.doesNotMatch(section,/indexing path is not supported yet/i);
 assert.doesNotMatch(section,/new connections are disabled/i);
});
