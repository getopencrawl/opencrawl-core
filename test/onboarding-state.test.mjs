import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deriveOnboarding} from '../web/onboarding-state.js';

const receipt={observedAt:'2026-11-05T12:00:00.000Z'};

test('each milestone must be present; authentication is not tool verification', () => {
  assert.deepEqual(deriveOnboarding(), {complete:false,step:'connect',completedCount:0});
  assert.deepEqual(deriveOnboarding({cli:receipt,mcp:receipt}), {complete:false,step:'verify',completedCount:1});
  assert.deepEqual(deriveOnboarding({cli:receipt,mcpTest:receipt}), {complete:false,step:'session',completedCount:2});
  assert.deepEqual(deriveOnboarding({cli:receipt,mcpTest:receipt,session:receipt}), {complete:true,step:'ready',completedCount:3});
  for (const [missing,step] of [['cli','connect'],['mcpTest','verify'],['session','session']]) {
    const status={cli:receipt,mcp:receipt,mcpTest:receipt,session:receipt};
    delete status[missing];
    assert.deepEqual(deriveOnboarding(status), {complete:false,step,completedCount:2});
  }
});

test('malformed receipts never unlock the dashboard', () => {
  for (const invalid of [null,true,{}, {observedAt:''},{observedAt:'invalid'},{observedAt:0}]) {
    for (const [key,step] of [['cli','connect'],['mcpTest','verify'],['session','session']]) {
      assert.deepEqual(deriveOnboarding({cli:receipt,mcp:receipt,mcpTest:receipt,session:receipt,[key]:invalid}),
        {complete:false,step,completedCount:2});
    }
  }
});

test('shows the next owner action and skips checks already completed out of order',()=>{
 assert.equal(deriveOnboarding({cli:receipt}).step,'mcp');
 assert.equal(deriveOnboarding({mcp:receipt}).step,'connect');
 assert.equal(deriveOnboarding({cli:receipt,mcp:{observedAt:'invalid'}}).step,'mcp');
 assert.equal(deriveOnboarding({cli:receipt,mcp:receipt}).step,'verify');
 assert.equal(deriveOnboarding({cli:receipt,mcpTest:receipt}).step,'session');
 assert.equal(deriveOnboarding({cli:receipt,mcp:receipt,session:receipt}).step,'verify');
 assert.equal(deriveOnboarding({cli:receipt,mcpTest:receipt,session:receipt}).step,'ready');
});

test('optional history neither blocks completion nor satisfies recording',()=>{
 const connected={cli:receipt,mcp:receipt,mcpTest:receipt};
 for(const state of ['complete','skipped','importing']){
  assert.equal(deriveOnboarding({...connected,history:{...receipt,state}}).step,'session');
  assert.equal(deriveOnboarding({...connected,session:receipt,history:{...receipt,state}}).complete,true);
 }
});
