import {test} from 'node:test';
import {withTestState} from './fixtures/memory-application-state.mjs';
import assert from 'node:assert/strict';
import {seedSlackSourceCatalog as seedFiles} from '../dist/src/connectors/slack-source-files.mjs';
import {seedSlackSourceCatalog as seedMessages,createSlackMessageCapture} from '../dist/src/connectors/slack-source-messages.mjs';
import {digest} from '../dist/src/connectors/scope.mjs';
import {gunzipSync} from 'node:zlib';

const binding={tenantId:'team',connectionId:'connection',workspaceId:'T123',provider:'slack',access:'team-public',rawPrefix:'raw/v1/source=slack/workspace=T123/connection=connection/'};
const fileKey=binding.rawPrefix+'capture/files-v1/catalog.json',messageKey=binding.rawPrefix+'capture/messages-v1/catalog.json';
function setup() {
 const objects=new Map(),writes=[];
 const store={get:async key=>objects.get(key),put:async(key,bytes)=>objects.set(key,Buffer.from(bytes))};
 const state=withTestState({store}).state,repository=state.slackCapture,merge=repository.mergeCatalog;
 repository.mergeCatalog=async(binding,kind,value)=>{writes.push(kind);return merge(binding,kind,value);};
 return {objects,states:repository.values,repository,state,writes,store,read:key=>{const value=JSON.parse(repository.values.get(key));value.channels.sort();return value;}};
}

test('one portable seed operation preserves both catalogs and unions trusted channel and file-share identities',async()=>{
 assert.equal(seedFiles,seedMessages);
 const h=setup(),scope=digest(binding);
 h.states.set(fileKey,Buffer.from(JSON.stringify({scope,channels:['C3'],files:{F0:['C3']}})));
 h.states.set(messageKey,Buffer.from(JSON.stringify({scope,channels:['C4']})));
 const options={binding,state:h.state,channelIds:['C1','C1'],fileShares:[{fileId:'F1',channelId:'C2'},{fileId:'F1',channelId:'C2'}]};
 assert.deepEqual(await seedFiles(options),{messageChannels:4,fileChannels:4,files:2,fileShares:2});
 assert.deepEqual(h.read(fileKey),{scope,channels:['C1','C2','C3','C4'],files:{F0:['C3'],F1:['C2']}});
 assert.deepEqual(h.read(messageKey),{scope,channels:['C1','C2','C3','C4']});
 const before=[...h.states].map(([key,bytes])=>[key,bytes.toString()]);
 await seedMessages(options);assert.deepEqual([...h.states].map(([key,bytes])=>[key,bytes.toString()]),before);
 assert.equal(h.objects.size,0,'Catalogs do not write object storage');
});

test('catalog seeding validates scope, identities and bounds before writing either catalog',async()=>{
 for(const invalid of ['scope','identity','unconfigured','shares','input']) {
  const h=setup(),options={binding,state:h.state};
  if(invalid==='scope')h.states.set(messageKey,Buffer.from(JSON.stringify({scope:'foreign',channels:[]})));
  if(invalid==='identity')h.states.set(fileKey,Buffer.from(JSON.stringify({scope:digest(binding),channels:[],files:{F1:['../foreign']}})));
  if(invalid==='unconfigured')delete options.state;
  if(invalid==='shares')options.fileShares=[{fileId:'F1',channelId:'../foreign'}];
  if(invalid==='input')options.channelIds=Array(100001).fill('C1');
  await assert.rejects(seedFiles(options));assert.deepEqual(h.writes,[]);
 }
 const h=setup();await assert.rejects(seedFiles({binding,state:h.state,checkActive:async()=>{throw Error('revoked');}}),/revoked/);assert.deepEqual(h.writes,[]);
});

test('retry after a partially committed seed preserves every identity',async()=>{
 const h=setup(),merge=h.repository.mergeCatalog;let fail=true;
 h.repository.mergeCatalog=async(binding,kind,value)=>{if(kind==='messages-v1'&&fail){fail=false;throw Error('lost write');}return merge(binding,kind,value);};
 await assert.rejects(seedFiles({binding,state:h.state,channelIds:['C1'],fileShares:[{fileId:'F1',channelId:'C2'}]}),/lost write/);
 assert.ok(h.states.has(fileKey));assert.ok(!h.states.has(messageKey));
 await seedFiles({binding,state:h.state,channelIds:['C3']});
 assert.deepEqual(h.read(messageKey).channels,['C1','C2','C3']);
 assert.deepEqual(h.read(fileKey).files,{F1:['C2']});
});

test('seeded historical channels are revoked by the first complete message capture without deleting source data',async()=>{
 const h=setup();
 await seedMessages({binding,state:h.state,channelIds:['C1','C2']});
 const capture=createSlackMessageCapture({binding,store:h.store,state:h.state,now:()=>1800000000000,request:async()=>({status:200,data:{ok:true,channels:[{id:'C2',is_private:false}]}})});
 await capture.step({runId:'upgraded',cutoff:1800000000000});
 const records=[...h.objects].filter(([key])=>key.includes('stream=channels/'))
  .flatMap(([,bytes])=>gunzipSync(bytes).toString().trim().split('\n').map(line=>JSON.parse(line)._airbyte_data));
 assert.deepEqual(records.map(channel=>[channel.id,channel.is_private]),[['C2',false],['C1',true]]);
 assert.deepEqual(h.read(messageKey).channels,['C1','C2']);
});
