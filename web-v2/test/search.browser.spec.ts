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
  connectors: {responses: [{hits: {hits: [{_id: 'release', _source: {provider: 'notion', kind: 'page', title: 'Release notes', url: 'https://example.com/notes', text: 'The onboarding release notes are ready for review.'}}]}}]},
};

for (const width of [390, 1280]) {
  test(`playground pages real queries and shows the source title link at ${width}px`, async ({page}, info) => {
    await page.setViewportSize({width, height: 900});
    const calls: Array<{query: string; page: number}> = [];
    await page.route('**/api/debug/search', route => {
      const input = route.request().postDataJSON() as {query: string; page: number};
      calls.push(input);
      return route.fulfill({json: diagnosticPage(result, input.page)});
    });
    await page.goto('/search');
    await expect(page.getByRole('region', {name: 'Inspect search', exact: true})).toHaveCSS('border-top-width', '1px');
    const field = page.getByRole('searchbox', {name: 'Search query'});
    await field.fill('onboarding'); await field.press('Enter');
    const hits = page.locator('.oc-search-hit');
    await expect(hits).toHaveCount(25);
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
    await expect(page.locator('.oc-search-summary')).toBeFocused();
    await expect(next).toBeDisabled();
    await expect(field).toHaveValue('edited draft');
    await page.getByRole('button', {name: 'Previous', exact: true}).click();
    await expect(hits).toHaveCount(25);
    expect(calls).toEqual([{query: 'onboarding', page: 1}, {query: 'onboarding', page: 2}, {query: 'onboarding', page: 1}]);
    await page.getByRole('button', {name: 'Surprise me'}).click();
    await expect(field).not.toHaveValue('edited draft');
    await expect(hits).toHaveCount(25);
    expect(calls.at(-1)).toEqual({query: await field.inputValue(), page: 1});
  });
}
