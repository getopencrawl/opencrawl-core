import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement, type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {AgentOnboarding, SourcesOnboarding, InviteOnboarding, type OnboardingAdapter, type OnboardingStatus} from '../src/onboarding/index.ts';
import {deriveOnboarding, hasReceipt, normalizeInvitationEmail, oauthDestination, safeWorkspacePath} from '../src/onboarding/model.ts';

const receipt = {observedAt: '2026-11-07T12:00:00.000Z'};
const complete: OnboardingStatus = {cli: receipt, mcpTest: receipt, session: receipt};
const adapter: OnboardingAdapter = {
  status: async () => complete,
  sources: async () => ({items: []}),
  connectSource: async () => ({ok: true}),
  invitations: async () => ({items: []}),
  invite: async email => ({items: [{email}], addedCount: 1}),
  finish: async () => ({workspaceUrl: '/'}),
};
const render = (element: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, {}, element));
const agent = (initialStatus: OnboardingStatus) => render(createElement(AgentOnboarding, {adapter, mcpUrl: 'https://app.getopencrawl.com/mcp', setupPrompt: 'The approved setup prompt.', initialStatus}));

test('only valid server receipts unlock the source step; imported history never substitutes for a fresh session', () => {
  assert.equal(hasReceipt({observedAt: ''}), false);
  assert.equal(hasReceipt({observedAt: 'not a date'}), false);
  assert.equal(deriveOnboarding({cli: receipt, mcp: receipt, history: {...receipt, state: 'complete'}}).step, 'verify');
  assert.equal(deriveOnboarding({cli: receipt, mcpTest: receipt, history: {...receipt, state: 'received'}}).step, 'session');
  assert.equal(deriveOnboarding(complete).complete, true);
  assert.doesNotMatch(agent({cli: receipt, mcpTest: receipt, history: {...receipt, state: 'complete'}}), /id="next-step"/);
  assert.match(agent(complete), /id="next-step"[^>]*href="\/onboarding\/sources"/);
});

test('completed agent setup preserves the original instruction, full grouped checklist, and independent prompt reveal', () => {
  const html = agent(complete);
  assert.match(html, /Connect your primary coding agent/);
  assert.match(html, /Connection checklist/);
  assert.match(html, /First session recording received/);
  assert.match(html, /Import past sessions/);
  assert.match(html, /aria-label="Show setup prompt" aria-expanded="false"/);
  assert.match(html, /class="prompt-preview" id="connect-preview" hidden=""/);
  assert.match(html, /class="onboarding-flow onboarding-flow-panel"/);
  assert.match(html, /class="focus-content focus-panel"/);
});

test('a tool receipt proves MCP sign-in but does not fabricate CLI or recording receipts', () => {
  const html = agent({mcpTest: receipt});
  assert.match(html, /Complete CLI sign-in/);
  assert.match(html, /MCP signed in/);
  assert.match(html, /Connection test passed/);
  assert.match(html, /Waiting for CLI sign-in/);
  assert.match(html, /Waiting for first session recording/);
  assert.doesNotMatch(html, /id="next-step"/);
});

test('sources do not advance when OAuth has only started, and small catalogs hide search', () => {
  const pending = render(createElement(SourcesOnboarding, {adapter, initialSources: [{id: 'source', name: 'Source', state: 'connecting'}]}));
  assert.doesNotMatch(pending, /id="next-step"/);
  assert.match(pending, /class="connector-search" hidden=""/);
  const connected = render(createElement(SourcesOnboarding, {adapter, initialSources: [{id: 'source', name: 'Source', state: 'syncing'}]}));
  assert.match(connected, /href="\/onboarding\/invite"/);
  assert.match(connected, /aria-label="Connected to Source"/);
});

test('members can finish without invitation access and invitation text is escaped', () => {
  const member = render(createElement(InviteOnboarding, {adapter, canInvite: false}));
  assert.match(member, /Your workspace admin can invite teammates/);
  assert.match(member, /Skip for now/);
  assert.doesNotMatch(member, /id="invite-emails"/);
  const admin = render(createElement(InviteOnboarding, {adapter, canInvite: true, initialInvitations: {items: [{email: '<script>@example.com'}]}}));
  assert.match(admin, /&lt;script&gt;@example.com/);
  assert.match(admin, /Open workspace/);
  assert.doesNotMatch(admin, /<script>/);
});

test('invitation input is one address and navigation contracts reject cross-origin workspace redirects', () => {
  assert.equal(normalizeInvitationEmail(' TEAM@EXAMPLE.COM '), 'team@example.com');
  assert.equal(normalizeInvitationEmail('a@example.com,b@example.com'), null);
  assert.equal(normalizeInvitationEmail('a@example'), null);
  assert.equal(safeWorkspacePath('/?setup=complete'), '/?setup=complete');
  assert.throws(() => safeWorkspacePath('//host.example'));
  assert.throws(() => safeWorkspacePath('/\\host.example'));
  assert.throws(() => safeWorkspacePath('https://host.example'));
  assert.equal(oauthDestination('https://accounts.example.com/authorize'), 'https://accounts.example.com/authorize');
  assert.throws(() => oauthDestination('javascript:alert(1)'));
  assert.throws(() => oauthDestination('https://secret@example.com'));
});
