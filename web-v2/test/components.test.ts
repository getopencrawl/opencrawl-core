import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {AppShell} from '../src/app.tsx';
import {Button, Field, Input} from '../src/design/components.tsx';

test('one registry owns active SPA navigation and page rendering', () => {
  const routes = [{path:'/', label:'Overview', element:createElement('h1', null, 'Overview page')}, {path:'/diagnostics', label:'Diagnostics', element:createElement('h1', null, 'Diagnostics page')}];
  const html = renderToStaticMarkup(createElement(MemoryRouter, {initialEntries:['/diagnostics']}, createElement(AppShell, {workspace:{name:'Example workspace'}, routes})));
  assert.equal((html.match(/<nav\b/g) || []).length, 1);
  assert.match(html, /aria-current="page"[^>]*class="oc-nav-link oc-nav-active"[^>]*href="\/diagnostics"/);
  assert.match(html, /Diagnostics page/);
  assert.doesNotMatch(html, /Overview page/);
});

test('button preserves native busy semantics and cannot accidentally submit forms', () => {
  const html = renderToStaticMarkup(createElement(Button, {'aria-busy':true}, 'Working'));
  assert.match(html, /type="button"/);
  assert.match(html, /aria-busy="true"/);
});

test('field associates its error with the input and visible label', () => {
  const html = renderToStaticMarkup(createElement(Field, {label:'Email', error:'Enter a valid email.', children:createElement(Input, {id:'email'})}));
  assert.match(html, /for="email"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby=/);
  assert.match(html, /role="alert"/);
});
