import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router';
import {CallbackChoices, readContinuation} from '../src/application/callback-view.tsx';

const model={name:'GitHub',returnTo:'/onboarding/sources',actions:[{label:'Connect <account>',url:'https://github.com/login/oauth/authorize?client_id=owned&state=bound.42'},{label:'Install GitHub App',url:'https://github.com/apps/owned-app/installations/new?state=bound'}]};
test('callback choices use accessible links and preserve the explicit GitHub selection',()=>{
  const value=readContinuation(JSON.stringify(model));assert.ok(value);
  const html=renderToStaticMarkup(createElement(MemoryRouter,null,createElement(CallbackChoices,{model:value})));
  assert.ok(html.includes('Connect &lt;account&gt;'));assert.ok(html.includes('state=bound.42'));assert.ok(html.includes('href="/onboarding/sources"'));
  assert.ok(!html.includes('<account>'));
});
test('callback model rejects off-origin navigation and malformed continuations',()=>{
  for(const url of ['javascript:alert(1)','https://evil.example/login/oauth/authorize','https://github.com@evil.example/login/oauth/authorize','https://u:p@github.com/login/oauth/authorize','https://github.com/settings/apps','//github.com/login/oauth/authorize'])assert.equal(readContinuation(JSON.stringify({...model,actions:[{label:'Connect',url}]})),null);
  for(const value of [null,{}, {...model,actions:[]},{...model,returnTo:'//evil.example'}])assert.equal(readContinuation(JSON.stringify(value)),null);
  assert.equal(readContinuation('invalid'),null);
});
