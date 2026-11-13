import {test} from 'node:test';
import assert from 'node:assert/strict';
import {capturedActor} from '../dist/src/sessions/actors.mjs';

test('actor display validates collector provenance and never promotes it to account authority',()=>{
 const userId='50000000-0000-4000-8000-000000000001';
 const actor={provider:'replicas',assurance:'collector-reported',kind:'human',workspaceId:'10000000-0000-4000-8000-000000000001',nativeId:'40000000-0000-4000-8000-000000000001',messageId:'user-1',userId,tenantId:'forged',role:'admin',name:'untrusted-inline'};
 const event={id:'e',kind:'message',data:{role:'user'},actor};
 const batch={actorProfiles:{[userId]:{provider:'replicas',userId,name:'Alice',email:'alice@example.test'}}};
 const displayed=capturedActor(event,batch);
 assert.equal(displayed.name,'Alice');assert.equal(displayed.email,'alice@example.test');
 assert.equal(displayed.role,undefined);assert.equal(displayed.tenantId,undefined);
 assert.equal(capturedActor({...event,data:{role:'assistant'}},batch),undefined);
 assert.equal(capturedActor({...event,actor:{...actor,assurance:'verified'}},batch),undefined);
 assert.equal(capturedActor({...event,actor:{...actor,userId:'not-a-platform-id'}},batch),undefined);
 assert.equal(capturedActor(event,{actorProfiles:{[userId]:{provider:'replicas',userId:'someone-else',name:'Wrong'}}}).name,undefined);
 assert.equal(capturedActor(event,{actorProfiles:{[userId]:{provider:'replicas',userId,name:'x'.repeat(257),email:'bad\nlabel'}}}).name,undefined);
 const unknown=capturedActor({...event,actor:{...actor,kind:'unknown'}},batch);
 assert.equal(unknown.userId,undefined);assert.equal(unknown.name,undefined);
});
