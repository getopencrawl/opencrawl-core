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
  assert.match(html, /<aside[^>]*class="oc-sidebar"/);
  assert.doesNotMatch(html, /oc-workspace-header|oc-app-header/);
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

test('the docked footer puts the person before their workspace in one account control', () => {
  const render = (workspace: {name: string; userName?: string; email?: string; role?: string}) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AppShell, {workspace, routes: []})));
  const html = render({name: 'Example workspace', userName: 'Alex', email: 'alex@example.test', role: 'Admin'});
  const trigger = html.match(/<button[^>]*class="[^"]*oc-account-trigger[^"]*"[^>]*>(.*?)<\/button>/)?.[1];
  assert.ok(trigger);
  assert.ok(trigger.indexOf('Alex') < trigger.indexOf('Example workspace'));
  assert.match(html, /<footer class="oc-account-zone"/);
  assert.match(trigger, /oc-workspace-icon/);
  assert.match(html, /popover="auto"/);
  assert.doesNotMatch(html, /oc-workspace-name|Your account|>Workspace</);
  const standalone = render({name: 'Self-hosted workspace'});
  assert.match(standalone, /oc-account-context/);
  assert.doesNotMatch(standalone, /oc-account-trigger|Your account/);
});
