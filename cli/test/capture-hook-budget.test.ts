import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

test('transcript reconciliation yields to queued uploads at the hook deadline and preserves deferred tails',async()=>{
 // Mocking built-in fs and the clock in a subprocess keeps other capture tests
 // and the operator's installed hooks/configuration out of this fixture.
 const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'fixtures/capture-hook-budget.mjs')],{stdout:'pipe',stderr:'pipe'});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
 expect(JSON.parse(stdout)).toEqual({
  firstSourcesRead:1,firstUploadClockMs:3000,readyUploaded:true,
  totalEvents:4,uniqueEvents:4,bothSourcesUploaded:true,lateTailPreserved:true,
  sourceCursorsComplete:true,queueEmpty:true,
 });
},20000);
