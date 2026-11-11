import {test, expect, type Page, type Route} from '@playwright/test';
import type {SessionSummary, Visibility} from '../src/pages/library-types.js';

const own: SessionSummary = {userId: 'alice', harness: 'codex', sessionId: 'shared', title: 'Shared session', private: false, mine: true, origin: 'desktop', host: 'laptop.local', firstActivityAt: null, lastActivityAt: '2026-11-11T10:00:00Z', events: 2};
type Change = {harness: string; sessionId: string; visibility: Visibility};
async function fixture(page: Page, change?: (route: Route, input: Change) => Promise<boolean>) {
  const sessions: SessionSummary[] = [own, {...own, sessionId: 'private', title: 'Private session', private: true}, {...own, userId: 'bob', sessionId: 'colleague', title: 'Colleague session', mine: false}].map(session => ({...session}));
  const writes: Change[] = [];
  await page.route('**/api/library/**', async route => {
    const input = route.request().postDataJSON() as Change & {scope?: string};
    const operation = route.request().url().split('/').at(-1);
    if (operation === 'visibility') {
      writes.push(input);
      if (change && await change(route, input)) return;
      const session = sessions.find(session => session.sessionId === input.sessionId);
      if (!session?.mine) return route.fulfill({status: 404, json: {error: 'Session not found'}});
      session.private = input.visibility === 'private';
      await route.fulfill({json: {visibility: input.visibility}});
    } else if (operation === 'read') {
      await route.fulfill({json: {session: sessions.find(session => session.sessionId === input.sessionId), events: [], total: 0, next: null, authors: {alice: 'Alex', bob: 'Blake'}}});
    } else {
      await route.fulfill({json: {sessions: sessions.filter(session => input.scope !== 'mine' || session.mine), limit: 50, authors: {alice: 'Alex', bob: 'Blake'}}});
    }
  });
  return writes;
}

for (const width of [1440, 390]) {
  test(`My sessions eye toggles sharing without opening a transcript at ${width}px`, async ({page}, testInfo) => {
    const writes = await fixture(page);
    await page.setViewportSize({width, height: 900});
    await page.goto('/sessions');
    await expect(page.getByRole('link', {name: /Colleague session/})).toBeVisible();
    await expect(page.getByRole('button', {name: /^Share session with team:/})).toHaveCount(0);
    await page.getByRole('tab', {name: 'My sessions'}).click();
    await expect(page).toHaveURL(/scope=mine/);
    const shared = page.getByRole('button', {name: 'Share session with team: Shared session', exact: true});
    const privateSession = page.getByRole('button', {name: 'Share session with team: Private session', exact: true});
    await expect(shared).toHaveAttribute('aria-pressed', 'true');
    await expect(shared).toHaveAttribute('title', 'Shared with team. Make private');
    await expect(privateSession).toHaveAttribute('aria-pressed', 'false');
    await expect(privateSession).toHaveAttribute('title', 'Private. Share with team');
    await expect(page.getByRole('button', {name: /^Share session with team:/})).toHaveCount(2);
    expect(await shared.evaluate(button => getComputedStyle(button).opacity)).toBe('1');
    if (width === 390) {const box = await shared.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44);}
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: testInfo.outputPath(`session-visibility-${width}.png`), fullPage: true});

    let navigations = 0;
    page.on('request', request => {if (request.isNavigationRequest()) navigations++;});
    await shared.focus();
    await page.keyboard.press('Enter');
    await expect(shared).toHaveAttribute('aria-pressed', 'false');
    const row = page.locator('.oc-row-item').filter({has: shared});
    await expect(row.getByText('Private', {exact: true})).toBeVisible();
    expect(writes).toEqual([{harness: 'codex', sessionId: 'shared', visibility: 'private'}]);
    await expect(page).toHaveURL(/scope=mine/);
    await shared.click();
    await expect(shared).toHaveAttribute('aria-pressed', 'true');
    await expect(row.getByText('Private', {exact: true})).toHaveCount(0);
    expect(writes.at(-1)).toEqual({harness: 'codex', sessionId: 'shared', visibility: 'team'});
    await page.getByRole('tab', {name: 'All sessions'}).click();
    await expect(page.getByRole('button', {name: /^Share session with team:/})).toHaveCount(0);
    await page.goBack();
    await expect(shared).toHaveAttribute('aria-pressed', 'true');
    await page.goForward();
    await expect(page.getByRole('tab', {name: 'All sessions'})).toHaveAttribute('aria-selected', 'true');
    expect(navigations).toBe(0);
  });
}

test('privacy changes wait for confirmation, prevent duplicate writes and recover after failure', async ({page}) => {
  let finish: (() => void) | undefined;
  const gate = new Promise<void>(resolve => {finish = resolve;});
  let fail = true;
  const writes = await fixture(page, async route => {
    if (!fail) return false;
    await gate;
    fail = false;
    await route.fulfill({status: 503, json: {error: 'Visibility could not be saved. Try again.'}});
    return true;
  });
  await page.goto('/sessions?scope=mine');
  const toggle = page.getByRole('button', {name: 'Share session with team: Shared session', exact: true});
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', {name: 'Delete session: Shared session', exact: true})).toBeDisabled();
  expect(writes).toHaveLength(1);
  finish?.();
  await expect(page.getByText(/Could not update visibility for “Shared session”/)).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText(/Could not update visibility for/)).toHaveCount(0);
  expect(writes).toHaveLength(2);
});

test('access revocation clears sessions and visibility controls', async ({page}) => {
  await fixture(page, async route => {
    await route.fulfill({status: 403, json: {error: 'Workspace access was revoked.'}});
    return true;
  });
  await page.goto('/sessions?scope=mine');
  await page.getByRole('button', {name: 'Share session with team: Shared session', exact: true}).click();
  await expect(page.getByText('Workspace access was revoked.')).toBeVisible();
  await expect(page.getByRole('button', {name: /^Share session with team:/})).toHaveCount(0);
  await expect(page.getByRole('link', {name: /Shared session/})).toHaveCount(0);
});
