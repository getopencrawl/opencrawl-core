import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProductApi} from '../src/application/client.ts';

test('a slow report cannot hold another procedure or share its cancellation signal',{timeout:2000},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const calls:Array<{url:string;signal:AbortSignal|null|undefined}>=[];
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  t.after(()=>release());
  globalThis.fetch=async(url,options)=>{
    const path=String(url);calls.push({url:path,signal:options?.signal});
    assert.equal(options?.method,'POST');assert.equal(options?.credentials,'same-origin');
    assert.ok(!path.includes(','));assert.ok(!path.includes('batch='));
    if(path.includes('console.usage'))await gate;
    return Response.json({result:{data:path.includes('console.sources')?{items:[]}:{} }});
  };
  const api=createProductApi(),slow=new AbortController(),fast=new AbortController();
  const usage=api.usage(slow.signal);
  try {
    assert.deepEqual(await api.sources(fast.signal),{items:[]});
    assert.equal(calls.length,2);assert.notEqual(calls[0]?.signal,calls[1]?.signal);
    fast.abort();assert.equal(slow.signal.aborted,false);
  } finally {release();await usage;}
});
