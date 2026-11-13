import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement, type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {AgentOnboarding, SourcesOnboarding, InviteOnboarding, type OnboardingAdapter, type OnboardingStatus} from '../src/onboarding/index.ts';
import {deriveOnboarding, hasReceipt, normalizeInvitationEmail, oauthDestination, safeWorkspacePath, promptModel} from '../src/onboarding/model.ts';

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

test('manual setup chooses a native installer and makes its command available before login on each OS',()=>{
  for(const windows of [false,true]){
    const {commands}=promptModel({mcpUrl:'https://selfhost.example/mcp',setupPrompt:'Approved prompt',windows});
    assert.match(commands.cli,windows?/install\.ps1/:/install\.sh/);
    assert.match(commands.cli,windows?/\$env:PATH =/:/export PATH=/);
    assert.match(commands.cli,/opencrawl login --api https:\/\/selfhost\.example$/);
    assert.doesNotMatch(commands.cli,/npm |node /);
  }
});

test('only valid server receipts unlock the source step; imported history never substitutes for a fresh session', () => {
  assert.equal(hasReceipt({observedAt: ''}), false);
  assert.equal(hasReceipt({observedAt: 'not a date'}), false);
  assert.equal(deriveOnboarding({cli: receipt, mcp: receipt, history: {...receipt, state: 'complete'}}).step, 'verify');
  assert.equal(deriveOnboarding({cli: receipt, mcpTest: receipt, history: {...receipt, state: 'received'}}).step, 'session');
  assert.equal(deriveOnboarding(complete).complete, true);
  assert.doesNotMatch(agent({cli: receipt, mcpTest: receipt, history: {...receipt, state: 'complete'}}), /id="next-step"/);
  assert.match(agent(complete), /id="next-step"[^>]*href="\/onboarding\/sources"/);
});

test('completed agent setup shows a compact success state with the checklist available on demand', () => {
  const html = agent(complete);
  assert.match(html, /Your coding agent is ready/);
  assert.match(html, /Connection checklist/);
  assert.match(html, /First session recording received/);
  assert.match(html, /Import past sessions/);
  assert.match(html, /<details class="completed-setup signal-disclosure"><summary>/);
  assert.doesNotMatch(html, /connect-preview|Copy setup prompt/);
  assert.match(html, /class="onboarding-flow onboarding-flow-panel"/);
  assert.match(html, /class="focus-content focus-panel"/);
});

test('workspace agent setup shares its prompt and receipts without restarting the onboarding flow', () => {
  const html = render(createElement(AgentOnboarding, {adapter, mcpUrl: 'https://app.getopencrawl.com/mcp', setupPrompt: 'The approved setup prompt.', initialStatus: complete, presentation: 'workspace'}));
  assert.match(html, /<h1[^>]*>Agent setup<\/h1>/);
  assert.match(html, /<h2[^>]*>Connect your primary coding agent<\/h2>/);
  assert.match(html, /The approved setup prompt\./);
  assert.match(html, /First session recording received/);
  assert.doesNotMatch(html, /<main|next-step|Next is available|onboarding-flow/);
});

test('history completion requires an explicit valid completion receipt and remains optional', () => {
  const histories: OnboardingStatus['history'][] = [null, {...receipt, state: 'received'}, {...receipt, state: 'importing'},
    {...receipt, state: 'skipped'}, {observedAt: 'not a date', state: 'complete'}];
  for (const history of histories) {
    const html = agent({...complete, history});
    const row = html.match(/<li[^>]*data-signal="history"[\s\S]*?<\/li>/)?.[0];
    assert.ok(row);
    assert.doesNotMatch(row, /data-complete|>Complete</);
    assert.match(row, /Optional/);
    assert.match(html, /id="next-step"[^>]*href="\/onboarding\/sources"/);
    if (history?.state === 'received') assert.match(row, /Some history received; full import unconfirmed\./);
  }
  const row = agent({...complete, history: {...receipt, state: 'complete'}}).match(/<li[^>]*data-signal="history"[\s\S]*?<\/li>/)?.[0];
  assert.ok(row);
  assert.match(row, /data-complete=""/);
  assert.match(row, />Imported</);
  assert.match(row, />Complete</);
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

test('sources are optional: a started OAuth only offers Skip for now, a confirmed connection offers Next, and small catalogs hide search', () => {
  const pending = render(createElement(SourcesOnboarding, {adapter, initialSources: [{id: 'source', name: 'Source', state: 'connecting'}]}));
  assert.match(pending, /id="next-step"[^>]*class="[^"]*onboarding-skip[^"]*"[^>]*href="\/onboarding\/invite"[^>]*><span>Skip for now<\/span>/);
  assert.doesNotMatch(pending, />Next</);
  assert.match(pending, /You can also add one later\./);
  assert.match(pending, /class="connector-search" hidden=""/);
  const connected = render(createElement(SourcesOnboarding, {adapter, initialSources: [{id: 'source', name: 'Source', state: 'syncing'}]}));
  assert.match(connected, /id="next-step"[^>]*href="\/onboarding\/invite"[^>]*><span>Next<\/span>/);
  assert.doesNotMatch(connected, /onboarding-skip|Skip for now/);
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
