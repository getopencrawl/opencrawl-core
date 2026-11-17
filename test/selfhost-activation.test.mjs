import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyStartup} from '../deploy/activation.mjs';
test('startup proof requires current healthy image provenance and stable container identities',()=>{
 const target='a'.repeat(40),project='fixture',writers=['app','worker'].map(service=>({Id:service,Image:'sha256:'+'b'.repeat(64),Config:{Labels:{'com.docker.compose.service':service,'com.docker.compose.project':project,'org.opencontainers.image.revision':target}},State:{Running:true,Health:{Status:'healthy'}}}));
 const images=[{Id:writers[0].Image,Config:{Labels:{'org.opencontainers.image.revision':target}}}];
 const replica={...writers[1],Id:'worker-2'};assert.equal(verifyStartup([...writers,replica],{project,target,images}).length,3);
 const proof=verifyStartup(writers,{project,target,images});assert.deepEqual(verifyStartup(writers,{project,target,images,expected:proof}),proof);
 assert.throws(()=>verifyStartup(writers,{project,target:'c'.repeat(40),images}),/source target/);
 const foreign=[{...images[0],Config:{Labels:{'org.opencontainers.image.revision':'c'.repeat(40)}}}];assert.throws(()=>verifyStartup(writers,{project,target,images:foreign}),/source target/);
 writers[1].Id='replacement';assert.throws(()=>verifyStartup(writers,{project,target,images,expected:proof}),/changed during/);
});
