import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {AppShell} from '../src/app.tsx';
import {Avatar, Button, Field, Input} from '../src/design/components.tsx';

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
  const render = (workspace: {name: string; userName?: string; email?: string; role?: string}, actions = false) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AppShell, {workspace, routes: [], footer: actions ? createElement('a', {href:'/auth/logout'}, 'Sign out') : undefined})));
  const html = render({name: 'Example workspace', userName: 'Alex', email: 'alex@example.test', role: 'Admin'}, true);
  const trigger = html.match(/<button[^>]*class="[^"]*oc-account-trigger[^"]*"[^>]*>(.*?)<\/button>/)?.[1];
  assert.ok(trigger);
  assert.ok(trigger.indexOf('Alex') < trigger.indexOf('Example workspace'));
  assert.match(html, /<footer class="oc-account-zone"/);
  assert.match(trigger, /oc-avatar/);
  assert.match(html, /popover="auto"/);
  assert.doesNotMatch(html, /oc-account-summary|oc-account-role/);
  assert.doesNotMatch(html, /oc-workspace-name|Your account|>Workspace</);
  const standalone = render({name: 'Self-hosted workspace'});
  assert.match(standalone, /oc-account-context/);
  assert.doesNotMatch(standalone, /oc-account-trigger|Your account/);
  assert.doesNotMatch(render({name: 'Example workspace', userName: 'Alex'}), /oc-account-trigger/);
  assert.doesNotMatch(render({name: 'Example workspace', email: 'alex@example.test'}), /oc-account-trigger/);
  assert.doesNotMatch(render({name: 'Example workspace', userName: 'Alex', email: 'alex@example.test', role: 'Admin'}), /oc-account-trigger/);
});

test('account avatars retain initials before loading and reject unsafe image URLs', () => {
  for (const src of [undefined, 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', '//other.example/photo', 'https://user:password@example.com/photo']) {
    const html = renderToStaticMarkup(createElement(Avatar, {name: 'Deep Utkarsh', src}));
    assert.match(html, />DU<\/span>/);
    assert.doesNotMatch(html, /<img\b/);
  }
  const html = renderToStaticMarkup(createElement(Avatar, {name: 'Deep Utkarsh', src: 'https://workoscdn.com/images/v1/example'}));
  assert.match(html, />DU<\/span>/);
  assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /alt=""/);
  assert.doesNotMatch(html, /data-loaded/);
});

test('settings sections live behind one account entry and share a single page heading', () => {
  const routes = [
    {path:'/', label:'Usage', element:createElement('p', null, 'Workspace report')},
    {path:'/settings/team', label:'Team', icon:'team' as const, group:'settings' as const, element:createElement('p', null, 'Member controls')},
    {path:'/settings/billing', label:'Billing', icon:'billing' as const, group:'settings' as const, element:createElement('p', null, 'Payment controls')},
  ];
  const html = renderToStaticMarkup(createElement(MemoryRouter, {initialEntries:['/settings/team']}, createElement(AppShell, {workspace:{name:'Example'}, routes})));
  const workspaceNavigation = html.match(/<nav id="workspace-navigation"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(workspaceNavigation);
  assert.doesNotMatch(workspaceNavigation, /Team|Billing/);
  assert.match(html, /oc-account-settings[^>]*href="\/settings\/team"/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1[^>]*>Settings<\/h1>/);
  assert.match(html, /<nav class="oc-settings-nav" aria-label="Settings">/);
  assert.match(html, /aria-current="page"[^>]*href="\/settings\/team"/);
  assert.match(html, /Member controls/);
  assert.doesNotMatch(html, /Payment controls/);
});


test('hidden Settings sections do not create tabs or an account entry', () => {
  const hidden = {path:'/settings/billing', label:'Billing', group:'settings' as const, navigation:false, element:createElement('p', null, 'Payment controls')};
  const team = {path:'/settings/team', label:'Team', group:'settings' as const, element:createElement('p', null, 'Member roster')};
  const render = (routes: Array<typeof hidden | typeof team>) => renderToStaticMarkup(createElement(MemoryRouter, {initialEntries:['/settings/team']}, createElement(AppShell, {workspace:{name:'Example'}, routes})));
  const html = render([team, hidden]);
  assert.match(html, /href="\/settings\/team"/);
  assert.doesNotMatch(html, /href="\/settings\/billing"/);
  assert.doesNotMatch(render([hidden]), /oc-account-settings/);
});
