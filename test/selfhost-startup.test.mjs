import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withTemporalStartupRetry} from '../dist/src/selfhost/worker.mjs';

test('self-host startup tolerates Temporal recovery but preserves binding failures and a retry deadline', async()=>{
  const unavailable=new Error('History hosts recovering',{cause:Object.assign(new Error('Unavailable'),{code:14})});
  let attempts=0;
  assert.equal(await withTemporalStartupRetry(async()=>{if(++attempts<3)throw unavailable;return 'schedule';},{delayMs:1,timeoutMs:1000}),'schedule');
  assert.equal(attempts,3);
  const mismatch=new Error('Session schedule binding mismatch');attempts=0;
  await assert.rejects(withTemporalStartupRetry(async()=>{attempts++;throw mismatch;},{delayMs:1}),error=>error===mismatch);
  assert.equal(attempts,1);
  await assert.rejects(withTemporalStartupRetry(async()=>{throw unavailable;},{delayMs:1,timeoutMs:5}),error=>error===unavailable);
});
