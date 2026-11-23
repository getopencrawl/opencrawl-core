import {expect, test} from '@playwright/test';
import type {DiagnosticSearch} from '../src/pages/types.js';
import {diagnosticPage} from '../../src/application/search-page.mts';

const articles = [
  ['Launch checklist for the public beta', 'Before launch, run the onboarding flow with a new workspace and confirm that the first session appears.'],
  ['First-run experience', 'The team reviewed onboarding on a narrow screen and simplified the connection step.'],
  ['Search result typography', 'Design review notes from the onboarding walkthrough.'],
];
const sessions = Array.from({length: 28}, (_, index) => ({
  _id: String(index), _source: {title: articles[index % 3]![0] + (index > 2 ? ' / ' + (index + 1) : ''),
    text: articles[index % 3]![1], userId: 'user', harness: 'codex', role: 'assistant', kind: 'message',
    project: 'Console', sessionId: 'workspace-' + index, timestamp: '2026-11-06T12:00:00Z'},
}));
const result: DiagnosticSearch = {
  sessions: [{scope: 'workspace', response: {hits: {total: {value: sessions.length}, hits: sessions}}}],
  connectors: {responses: [{hits: {total: {value: 1}, hits: [{_id: 'release', _source: {provider: 'notion', kind: 'page', title: 'Release notes', url: 'https://example.com/notes', text: 'The onboarding release notes are ready for review.'}}]}}]},
};

for (const width of [390, 1280]) {
  test(`prompt, board reply and connector document are distinguishable at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width, height: 900});
    const mixed: DiagnosticSearch = {
      sessions: [{scope: 'workspace', response: {hits: {total: {value: 1}, hits: [{_source: {
        title: 'Public beta launch', role: 'user', kind: 'message', userId: 'user', sessionId: 'beta', harness: 'codex',
        text: 'Can we run through the launch checklist before we invite the first team?',
      }}]}}}],
      board: {hits: {total: {value: 1}, hits: [{_id: '42', _source: {channel: 'releases', author: 'release-review',
        messageId: 42, threadId: 40, text: 'The launch checklist is ready for a final review.'}}]}},
      connectors: {responses: [{hits: {total: {value: 1}, hits: [{_source: {provider: 'notion', kind: 'page',
        title: 'Release playbook', url: 'https://example.com/playbook', text: 'Use the launch checklist to verify onboarding. Start with an empty workspace, connect a source, and make sure the first result opens the original document. Invite a teammate to repeat the flow, then record anything that would slow down the next team.'}}]}}]},
    };
    await page.route('**/api/debug/search', route => route.fulfill({json: diagnosticPage(mixed, 1)}));
    await page.goto('/search');
    const field = page.getByRole('searchbox', {name: 'Search query'});
    await field.fill('launch checklist'); await field.press('Enter');
    await expect(page.locator('.oc-search-summary')).toHaveText('3 results');
    await expect(page.locator('.oc-search-hit details, .oc-search-results > details')).toHaveCount(0);
    await expect(page.locator('.oc-search-prompt')).toContainText('User prompt');
    await expect(page.getByRole('link', {name: 'Public beta launch'})).toHaveAttribute('href', /\/sessions\?/);
    await expect(page.getByRole('link', {name: '#releases'})).toHaveAttribute('href', '/messages?view=board&channel=releases&thread=40&message=42');
    await expect(page.getByRole('link', {name: 'Release playbook'})).toHaveAttribute('href', 'https://example.com/playbook');
    await expect(page.locator('.oc-search-hit mark')).toHaveText(['launch checklist', 'launch checklist', 'launch checklist']);
    await page.evaluate(async () => {await document.fonts.ready;});
    await page.screenshot({path: info.outputPath(`mixed-${width}.png`)});
  });
}

for (const width of [390, 801, 1280, 1920]) {
  test(`playground pages real queries and shows the source title link at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width, height: 900});
    const calls: Array<{query: string; page: number}> = [];
    await page.route('**/api/debug/search', route => {
      const input = route.request().postDataJSON() as {query: string; page: number};
      calls.push(input);
      return route.fulfill({json: diagnosticPage(result, input.page)});
    });
    const edges = (element: Element) => {
      const {left, right} = element.getBoundingClientRect();
      return {left, right};
    };
    await page.goto('/sessions');
    const libraryEdges = await page.locator('main .query-form').evaluate(edges);
    await page.goto('/search');
    const inspector = page.getByRole('region', {name: 'Inspect search', exact: true});
    await expect(inspector).toHaveCSS('border-top-width', '0px');
    const form = inspector.locator('form');
    const center = (element: Element) => {
      const {left, top, width, height} = element.getBoundingClientRect();
      return {x: left + width / 2, y: top + height / 2};
    };
    const bodyCenter = await page.locator('main .oc-page-scroll').evaluate(center);
    const formCenter = await form.evaluate(center);
    expect(Math.abs(formCenter.x - bodyCenter.x)).toBeLessThan(1);
    expect(Math.abs(formCenter.y - bodyCenter.y)).toBeLessThan(1);
    await page.screenshot({path: info.outputPath(`empty-${width}.png`)});
    const header = page.locator('main .oc-page-header');
    await expect(header).toHaveCSS('border-bottom-width', '1px');
    const headerBottom = await header.evaluate(element => element.getBoundingClientRect().bottom);
    const field = page.getByRole('searchbox', {name: 'Search query'});
    await field.fill('onboarding'); await field.press('Enter');
    const hits = page.locator('.oc-search-hit');
    await expect(hits).toHaveCount(25);
    expect(await form.evaluate(edges)).toEqual(libraryEdges);
    expect(await form.evaluate(element => element.getBoundingClientRect().top) - headerBottom).toBe(32);
    const summary = page.locator('.oc-search-summary');
    await expect(summary).toHaveText('1–25 of 29 results');
    await expect(page.getByRole('heading', {name: /Agent sessions|Connected sources/})).toHaveCount(0);
    expect(await page.locator('.oc-search-group').first().evaluate(edges)).toEqual(libraryEdges);
    await expect(hits.first().getByRole('link')).toHaveAttribute('href', /\/sessions\?user=user&harness=codex&id=workspace-0/);
    await expect(page.getByRole('link', {name: 'Release notes', exact: true})).toHaveAttribute('href', 'https://example.com/notes');
    await expect(hits.first().locator('mark')).toHaveText('onboarding');
    await page.evaluate(async () => {await document.fonts.ready;});
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path: info.outputPath(`playground-${width}.png`)});
    await field.fill('edited draft');
    const next = page.getByRole('button', {name: 'Next', exact: true});
    await next.focus(); await next.press('Enter');
    await expect(hits).toHaveCount(4);
    await expect(hits.first()).toContainText('25');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveText('26–29 of 29 results for “onboarding”');
    await expect(next).toBeDisabled();
    await expect(field).toHaveValue('edited draft');
    await page.getByRole('button', {name: 'Previous', exact: true}).click();
    await expect(hits).toHaveCount(25);
    expect(calls).toEqual([{query: 'onboarding', page: 1}, {query: 'onboarding', page: 2}, {query: 'onboarding', page: 1}]);
    await page.getByRole('button', {name: 'Surprise me'}).click();
    await expect(field).not.toHaveValue('edited draft');
    await expect(hits).toHaveCount(25);
    expect(calls.at(-1)).toEqual({query: await field.inputValue(), page: 1});
    await field.fill('');
    await expect(hits).toHaveCount(0);
    await expect(summary).toHaveCount(0);
    await expect(field).toBeFocused();
    expect(await form.evaluate(center)).toEqual(formCenter);
    await field.fill('new draft');
    expect(await form.evaluate(center)).toEqual(formCenter);
  });
}
