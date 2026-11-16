import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=async scenario=>JSON.parse((await promisify(execFile)(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./fixtures/connector-standalone-scope.mjs',import.meta.url)),scenario],{timeout:15000})).stdout);
test('standalone connector worker rejects mismatched SQL source before external operations',async()=>{
  for(const scenario of ['bucket','tenant']){const result=await run(scenario);assert.ok(result.error);assert.deepEqual(result.calls,[]);assert.deepEqual(result.closed,['application']);}
});
test('standalone connector worker closes resources after schedule failure and normal completion',async()=>{
  const failure=await run('schedule-failure');assert.match(failure.error,/schedule unavailable/);assert.deepEqual(failure.calls,['object-access','search-index','bundle','schedule']);assert.deepEqual(new Set(failure.closed),new Set(['application','client']));
  const success=await run('valid');assert.equal(success.error,undefined);assert.deepEqual(success.calls,['object-access','search-index','bundle','schedule','worker']);assert.deepEqual(new Set(success.closed),new Set(['application','client','worker']));
});
