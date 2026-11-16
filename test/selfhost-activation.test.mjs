import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activateConnectors,verifyStartup} from '../deploy/activation.mjs';
test('upgrade completion accepts only explicit full connector activation evidence',()=>{
 const complete={required:true,completed:true,connections:1,activationId:'a'.repeat(64),manifest:'b'.repeat(64),migrationId:'11111111-1111-4111-8111-111111111111'};
 assert.deepEqual(activateConnectors({compose:()=>JSON.stringify({connectorCatchup:complete})}),complete);
 for(const result of [{completed:true},{...complete,completed:false},{...complete,manifest:null},{...complete,required:false},{}])assert.throws(()=>activateConnectors({compose:()=>JSON.stringify({connectorCatchup:result})}),/incomplete/);
 assert.throws(()=>activateConnectors({compose:()=>''}),/verified completion/);assert.throws(()=>activateConnectors({compose:()=>{throw Error('worker failed');}}),/worker failed/);
});

test('startup proof requires current healthy image provenance and stable container identities',()=>{
 const target='a'.repeat(40),project='fixture',writers=['app','worker'].map(service=>({Id:service,Image:'sha256:'+'b'.repeat(64),Config:{Labels:{'com.docker.compose.service':service,'com.docker.compose.project':project,'org.opencontainers.image.revision':target}},State:{Running:true,Health:{Status:'healthy'}}}));
 const images=[{Id:writers[0].Image,Config:{Labels:{'org.opencontainers.image.revision':target}}}];
 const replica={...writers[1],Id:'worker-2'};assert.equal(verifyStartup([...writers,replica],{project,target,images}).length,3);
 const proof=verifyStartup(writers,{project,target,images});assert.deepEqual(verifyStartup(writers,{project,target,images,expected:proof}),proof);
 assert.throws(()=>verifyStartup(writers,{project,target:'c'.repeat(40),images}),/source target/);
 const foreign=[{...images[0],Config:{Labels:{'org.opencontainers.image.revision':'c'.repeat(40)}}}];assert.throws(()=>verifyStartup(writers,{project,target,images:foreign}),/source target/);
 writers[1].Id='replacement';assert.throws(()=>verifyStartup(writers,{project,target,images,expected:proof}),/changed during/);
});
