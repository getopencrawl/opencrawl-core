import assert from 'node:assert/strict';
import test from 'node:test';
import {createConsoleReloadCache, consoleDocument} from '../dist/src/application/console.mjs';

test('reload includes only this session, role, workspace and route, strips private links, and expires', () => {
  let now = 0;
  const cache = createConsoleReloadCache({}, () => now);
  const remember = (op, data) => cache.begin('org-a', 'session-a-admin', op)(data);
  remember('console.bootstrap', {cacheScope:'session-a-admin', onboarding:{completed:true}});
  remember('console.team', {members:[{name:'</script><b>Alex</b>'}], invitations:[{email:'a@example.test',inviteUrl:'private-link'}], workspaces:[{id:'elsewhere',name:'Other workspace'}]});
  assert.equal(cache.read('org-b','session-a-admin','/team'), undefined);
  assert.equal(cache.read('org-a','session-a-member','/team'), undefined);
  assert.equal(cache.read('org-a','another-session','/team'), undefined);
  const warm = cache.read('org-a','session-a-admin','/team');
  const html = consoleDocument(undefined, {reload:warm});
  assert.match(html, /opencrawl-reload/);
  assert.doesNotMatch(html, /private-link|Other workspace|<b>Alex/);
  assert.deepEqual(cache.read('org-a','session-a-admin','/sessions').reports, {});
  assert.equal(cache.begin('org-a','session-a-admin','library.sessions.read'), undefined);
  now += 600001;
  assert.equal(cache.read('org-a','session-a-admin','/team'), undefined);
});

test('older, oversized, or invalidated reads cannot resurrect a previous report', () => {
  const cache = createConsoleReloadCache();
  const begin = op => cache.begin('a','scope',op);
  begin('console.bootstrap')({cacheScope:'scope',onboarding:{completed:true}});
  const slow = begin('console.sources');
  begin('console.sources')({items:['current']});slow({items:['old']});
  assert.deepEqual(cache.read('a','scope','/sources').reports['console.sources'],{items:['current']});
  begin('console.sources')({items:['x'.repeat(100000)]});
  assert.deepEqual(cache.read('a','scope','/sources').reports,{});
  const pending = begin('console.bootstrap');
  cache.invalidate('a');pending({cacheScope:'scope',onboarding:{completed:true}});
  assert.equal(cache.read('a','scope','/sources'),undefined);
});

test('a warm document rechecks access and notices invalidation while that check is pending', async () => {
  const cache = createConsoleReloadCache();
  const prime = () => cache.begin('a','scope','console.bootstrap')({cacheScope:'scope',onboarding:{completed:true}});
  prime();
  assert.equal(await cache.forDocument('a','scope','/team',async () => false), false);
  assert.equal(cache.read('a','scope','/team'), undefined);
  prime();
  assert.equal(await cache.forDocument('a','scope','/team',async () => {cache.invalidate('a');return true;}), undefined);
});
