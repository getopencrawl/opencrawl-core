import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSuggestionEvents} from '../dist/src/search/suggestion-events.mjs';
import {loadContextSuggestions} from '../dist/src/selfhost/context-suggestions.mjs';
import {createContextCheck,lexicalCheckJudgment} from '../dist/src/search/check.mjs';

const principal={tenantId:'a',userId:'alice'};
const event=()=>({id:randomUUID(),at:new Date().toISOString(),harness:'codex',stage:'observed',eventKey:'a'.repeat(64),sessionHash:'b'.repeat(64)});
test('suggestion observations reject raw content, forged scope, stale reports and capture-only credentials',async()=>{
  const seen=[],run=createSuggestionEvents({authorize:async p=>{if(p.tenantId!=='a')throw Object.assign(Error('denied'),{status:403});},observe:async(p,events)=>seen.push({p,events})});
  for(const input of [{events:[{...event(),prompt:'private'}]},{events:[event()],tenantId:'b'},{events:Array.from({length:25},event)},{events:[{...event(),at:'2020-01-01T00:00:00Z'}]}])await assert.rejects(run(principal,input),{status:400});
  await assert.rejects(run({...principal,captureAccess:'write'},{events:[event()]}),{status:403});
  await assert.rejects(run({...principal,tenantId:'b'},{events:[event()]}),{status:403});assert.equal(seen.length,0);
  const e=event();assert.deepEqual(await run(principal,{events:[e]}),{accepted:[e.id],observed:true});assert.deepEqual(seen[0],{p:principal,events:[e]});
  const local=createSuggestionEvents({authorize:async()=>{}});assert.equal((await local(principal,{events:[event()]})).observed,false);
});
test('operator extension loads explicitly and drives the same bounded self-host operation without hosted credentials',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'suggestion-extension-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  assert.deepEqual(await loadContextSuggestions(undefined),{});await assert.rejects(loadContextSuggestions('relative.mjs'),/absolute/);
  const path=join(dir,'judgment.mjs');await writeFile(path,`export const judgment=()=>({version:'operator-v1',async plan(){return []},async shortlist(){return []},async rank(){return []}});`);
  const extension=await loadContextSuggestions(path);assert.equal(extension.judgment().version,'operator-v1');
  const run=createContextCheck({search:{async search(){throw Error('no search needed')},async fetch(){throw Error('no fetch needed')}},judge:extension.judgment,authorize:async()=>{}});
  const result=await run(principal,{eventId:'1',currentSession:{harness:'codex',sessionId:'local'},message:'Hello'});
  assert.equal(result.policyVersion,'operator-v1');assert.deepEqual(result.results,[]);assert.equal(lexicalCheckJudgment().version,'lexical-v1');
  const bad=join(dir,'bad.mjs');await writeFile(bad,'export const judgment="wrong"');await assert.rejects(loadContextSuggestions(bad),/export/);
});
