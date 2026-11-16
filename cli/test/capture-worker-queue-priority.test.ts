import {test,expect} from 'bun:test';
import {resolve} from 'node:path';

test('owned-window reconciliation cannot postpone already queued uploads behind a stale source catalogue',async()=>{
 const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'fixtures/capture-worker-queue-priority.mjs')],{stdout:'pipe',stderr:'pipe'});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
 expect({exit,stderr}).toEqual({exit:0,stderr:''});
 const result=JSON.parse(stdout);
 expect(result.firstUploadClockMs).toBe(0);
 expect(result.lookupsBeforeFirstUpload).toBe(0);
 expect(result.firstPassLookups).toBeLessThanOrEqual(5);
 expect(result.firstPassDeferredSources).toBe(true);
 expect(result.readySessionsUploaded).toBe(7);
 expect(result.totalEvents).toBe(11);
 expect(result.uniqueEvents).toBe(11);
 expect(result.allSourcesUploaded).toBe(true);
 expect(result.lateTailPreserved).toBe(true);
 expect(result.sourceCursorsComplete).toBe(true);
 expect(result.queueEmpty).toBe(true);
},20000);
