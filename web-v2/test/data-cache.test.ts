import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consoleResourceKey, createConsoleQueryClient} from '../src/data.tsx';

test('route remounts share fresh reads; stale refresh keeps the last report visible',async()=>{
  const cache=createConsoleQueryClient(), key=consoleResourceKey({},'usage');let reads=0;
  const queryFn=async()=>({sessions:++reads});
  assert.deepEqual(await cache.fetchQuery({queryKey:key,queryFn}),{sessions:1});
  assert.deepEqual(await cache.fetchQuery({queryKey:key,queryFn}),{sessions:1});
  assert.equal(reads,1);
  await cache.invalidateQueries({queryKey:key});
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const pending=cache.fetchQuery({queryKey:key,queryFn:async()=>{await gate;return {sessions:2};}});
  assert.deepEqual(cache.getQueryData(key),{sessions:1});release();await pending;
  assert.deepEqual(cache.getQueryData(key),{sessions:2});cache.clear();
});
test('scope caches and adapter identities cannot reuse another principal or adapter data',async()=>{
  const a=createConsoleQueryClient(),b=createConsoleQueryClient(),first={},second={};
  const key=consoleResourceKey(first,'usage');a.setQueryData(key,{private:'workspace A'});
  assert.equal(b.getQueryData(key),undefined);
  assert.notDeepEqual(consoleResourceKey(second,'usage'),key);
  assert.deepEqual(consoleResourceKey(first,'usage'),key);a.clear();b.clear();
});
test('shared reads deduplicate and cancellation prevents late completion from restoring data',async()=>{
  const cache=createConsoleQueryClient(),key=['slow'];let finish:()=>void=()=>{},reads=0;
  const gate=new Promise<void>(resolve=>{finish=resolve;});
  const queryFn=async({signal}:{signal:AbortSignal})=>{reads++;void signal.aborted;await gate;return 'private';};
  const first=cache.fetchQuery({queryKey:key,queryFn}).catch(()=>undefined);
  const second=cache.fetchQuery({queryKey:key,queryFn}).catch(()=>undefined);
  assert.equal(reads,1);await cache.cancelQueries();cache.clear();finish();await Promise.all([first,second]);
  assert.equal(cache.getQueryData(key),undefined);
});
test('only access failures notify the scope owner; transient refresh failures retain cached data',async()=>{
  const errors:unknown[]=[],cache=createConsoleQueryClient(error=>errors.push(error)),key=['team'];
  cache.setQueryData(key,{name:'current'});await cache.invalidateQueries({queryKey:key});
  await assert.rejects(cache.fetchQuery({queryKey:key,queryFn:async()=>{throw Object.assign(Error('Temporary'),{status:503});}}));
  assert.deepEqual(cache.getQueryData(key),{name:'current'});assert.equal(errors.length,0);
  await assert.rejects(cache.fetchQuery({queryKey:['denied'],queryFn:async()=>{throw Object.assign(Error('Revoked'),{status:403});}}));
  assert.equal(errors.length,1);cache.clear();
});
