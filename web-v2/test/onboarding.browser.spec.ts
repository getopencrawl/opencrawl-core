import {test, expect, type Page} from '@playwright/test';
import type {} from './fixtures/onboarding-app.tsx';

const receipt = {observedAt: '2026-11-07T12:00:00.000Z'};
const complete = {cli: receipt, mcpTest: receipt, session: receipt};
const connected = [{id: 'slack', name: 'Slack', icon: '/assets/connectors/slack.svg', state: 'syncing', auth: 'oauth'}];

test.beforeEach(async ({request}) => {await request.post('/__test/reset', {data: {}});});

async function refresh(page: Page) {await page.evaluate(() => window.dispatchEvent(new Event('online')));}

test('GitHub account choice preserves keyboard access, narrow layout and the selected OAuth state',async({page})=>{
  await page.route('https://github.com/login/oauth/authorize?**',route=>route.fulfill({contentType:'text/html',body:'<h1>GitHub authorization fixture</h1>'}));
  for(const width of [1280,390]) {
    await page.setViewportSize({width,height:800});
    await page.goto('/callback-selection');
    await expect(page.getByRole('heading',{name:'Connect GitHub',exact:true})).toBeVisible();
    const second=page.getByRole('link',{name:'Connect second account'});
    await second.focus();await expect(second).toBeFocused();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('https://github.com/login/oauth/authorize?client_id=owned&state=bound.43');
    await expect(page.getByRole('heading',{name:'GitHub authorization fixture'})).toBeVisible();
  }
});

test('receipts, manual copy, and the three-step flow preserve one browser document', async ({page, request}) => {
  let documentLoads = 0;
  page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentLoads++;});
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async () => {throw new Error('Clipboard denied');}}}));
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: 'Show setup prompt'}).click();
  await expect(page.locator('#connect-preview')).toBeVisible();
  await page.getByRole('button', {name: 'Copy setup prompt', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Copy this prompt'})).toBeVisible();
  await expect(page.getByLabel('Prompt to copy')).toBeFocused();
  expect(await page.getByLabel('Prompt to copy').evaluate((node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart)).toBeGreaterThan(100);
  await page.getByRole('button', {name: 'I’ve copied it'}).click();
  await expect(page.locator('.copy-prompt')).toBeFocused();

  await request.post('/__test/state', {data: {status: {cli: receipt, mcp: receipt, history: {...receipt, state: 'complete'}}}});
  await refresh(page);
  await expect(page.getByRole('heading', {name: 'Ask your agent to test the connection'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await request.post('/__test/state', {data: {status: complete}});
  await refresh(page);
  await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByRole('link', {name: 'Next', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Connect your sources'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
  await page.getByRole('link', {name: 'Next', exact: true}).click();
  await page.getByRole('button', {name: 'Connect Granola', exact: true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('API key')).toBeFocused();
  await page.getByLabel('API key').fill('test-only-key');
  await page.getByRole('dialog').getByRole('button', {name: 'Connect Granola', exact: true}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Connected to Granola'})).toBeVisible();
  await page.getByRole('link', {name: 'Next', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Invite your teammates'})).toBeVisible();
  await page.getByRole('textbox', {name: 'Email address'}).fill('teammate@example.com');
  await page.getByRole('textbox', {name: 'Email address'}).press('Enter');
  await expect(page.getByText('teammate@example.com', {exact: true})).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Email address'})).toHaveValue('');
  await expect(page.getByRole('textbox', {name: 'Email address'})).toBeFocused();
  await page.getByRole('button', {name: 'Open workspace'}).click();
  await expect(page.getByRole('heading', {name: 'Workspace overview'})).toBeVisible();
  expect(documentLoads).toBe(1);
  const state = await (await request.get('/__test/state')).json() as {requests: {finish: number; invite: number}};
  expect(state.requests.finish).toBe(1);
  expect(state.requests.invite).toBe(1);
});

test('finish errors stay in the flow and do not infer completion from a button click', async ({page, request}) => {
  await request.post('/__test/state', {data: {status: complete, sources: connected, finishError: true}});
  await page.goto('/onboarding/invite');
  await page.getByRole('button', {name: 'Skip for now'}).click();
  await expect(page.getByRole('alert')).toHaveText('Complete the required setup checks first.');
  await expect(page).toHaveURL(/\/onboarding\/invite$/);
  await expect(page.getByRole('button', {name: 'Skip for now'})).toBeEnabled();
});

test('received history stays unconfirmed and optional until an explicit completion receipt arrives', async ({page, request}, testInfo) => {
  await request.post('/__test/state', {data: {status: {...complete, history: {...receipt, state: 'received'}}}});
  await page.goto('/onboarding');
  const history = page.locator('[data-signal="history"]');
  await expect(history).not.toHaveAttribute('data-complete', '');
  await expect(history.locator('.signal-status')).toHaveText('Pending');
  await expect(history.locator('.signal-detail')).toHaveText('Some history received; full import unconfirmed.');
  await expect(history.locator('.optional-label')).toHaveText('Optional');
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
  await page.setViewportSize({width: 390, height: 844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('received-history-mobile.png'), fullPage: true});
  await history.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(history.locator('details')).toHaveAttribute('open', '');
  await expect(history.getByText('Choose Claude Code, Codex, both, or skip in your terminal.')).toBeVisible();
  await request.post('/__test/state', {data: {status: {...complete, history: {...receipt, state: 'complete'}}}});
  await refresh(page);
  await expect(history).toHaveAttribute('data-complete', '');
  await expect(history.locator('.signal-status')).toHaveText('Complete');
  await expect(history.locator('.signal-detail')).toHaveText('Imported');
  await expect(history.locator('details')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
});

test('leaving a route aborts the pending receipt request', async ({page, request}) => {
  await request.post('/__test/state', {data: {delayStatus: 20_000}});
  await page.goto('/onboarding');
  await expect.poll(async () => ((await (await request.get('/__test/state')).json()) as {requests: {status: number}}).requests.status).toBe(1);
  await page.evaluate(() => window.__onboardingTestNavigate?.('/away'));
  await expect(page.getByRole('heading', {name: 'Different route'})).toBeVisible();
  await expect.poll(async () => ((await (await request.get('/__test/state')).json()) as {requests: {aborted: number}}).requests.aborted).toBe(1);
});

test('OAuth is an explicit external navigation and returns to the same source step', async ({page, request}) => {
  await request.post('/__test/state', {data: {status: complete}});
  await page.route('https://provider.example/authorize', route => route.fulfill({contentType: 'text/html', body: '<h1>Provider authorization fixture</h1>'}));
  await page.goto('/onboarding/sources');
  await page.getByRole('button', {name: 'Connect Slack', exact: true}).click();
  await expect(page).toHaveURL('https://provider.example/authorize');
  await request.post('/__test/state', {data: {sources: connected}});
  await page.goto('/onboarding/sources');
  await expect(page.getByRole('button', {name: 'Connected to Slack'})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
  await expect(page).toHaveURL(/\/onboarding\/sources$/);
});

for (const viewport of [{name: 'desktop', width: 1440, height: 1000}, {name: 'mobile', width: 390, height: 844}]) {
  test(`preserves approved onboarding geometry and long-text usability at ${viewport.name} width`, async ({page, request}, testInfo) => {
    await request.post('/__test/state', {data: {status: complete}});
    await page.setViewportSize({width: viewport.width, height: viewport.height});
    await page.goto('/onboarding');
    await expect(page.getByRole('link', {name: 'Next', exact: true})).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const panel = await page.locator('.focus-panel').boundingBox();
    const heading = page.getByRole('heading', {name: 'Connect your primary coding agent'});
    const typography = await heading.evaluate(node => ({size: getComputedStyle(node).fontSize, weight: getComputedStyle(node).fontWeight, family: getComputedStyle(node).fontFamily, align: getComputedStyle(node).textAlign}));
    expect(typography.size).toBe(viewport.name === 'mobile' ? '30px' : '36px');
    expect(typography.weight).toBe('550');
    expect(typography.family).toContain('Geist');
    expect(typography.align).toBe('left');
    expect(panel).not.toBeNull();
    if (!panel) throw new Error('Onboarding panel is missing');
    expect(panel.width).toBe(Math.min(640, viewport.width - 48));
    expect(panel.x).toBe((viewport.width - panel.width) / 2);
    expect(panel.y).toBe(viewport.name === 'mobile' ? 80 : 112);
    const navigation = await page.locator('.onboarding-navigation').boundingBox();
    expect(navigation).not.toBeNull();
    if (!navigation) throw new Error('Onboarding navigation is missing');
    expect(navigation.y).toBeGreaterThanOrEqual(panel.y + panel.height + 24);
    expect(navigation.x + navigation.width).toBe(panel.x + panel.width);
    await page.screenshot({path: testInfo.outputPath(`onboarding-${viewport.name}.png`), fullPage: true});
    await page.getByRole('button', {name: 'Show setup prompt'}).click();
    await expect(page.locator('#connect-preview')).toBeVisible();
    await page.screenshot({path: testInfo.outputPath(`react-long-prompt-${viewport.name}.png`), fullPage: true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await request.post('/__test/state', {data: {invitations: [{email: `${'long-address-'.repeat(10)}@example.com`}]}});
    await page.getByRole('link', {name: 'Next', exact: true}).click();
    await page.evaluate(() => window.__onboardingTestNavigate?.('/onboarding/invite'));
    await expect(page.locator('.invitation-email')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('the person and workspace stay together in the docked account menu', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 800});
  await page.goto('/workspace');
  const trigger = page.getByRole('button', {name: 'Alex, Example workspace. Account menu', exact: true});
  const account = page.getByRole('group', {name: 'Account details', exact: true});
  await expect(trigger.locator('strong')).toHaveText('Alex');
  await expect(trigger).toContainText('Example workspace');
  await expect(page.getByText('Your account', {exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Sign out', exact: true})).not.toBeVisible();
  await trigger.click();
  await expect(account).toBeVisible();
  await expect(account).toContainText('alex@example.test');
  await page.keyboard.press('Escape');
  await expect(account).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('heading', {name: 'Console home'}).click();
  await expect(account).not.toBeVisible();
  await trigger.click();
  await page.getByRole('link', {name: 'Team', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Console team'})).toBeVisible();
  await expect(account).not.toBeVisible();
});

test('mobile account disclosure closes before the drawer and hidden actions leave the focus loop', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/workspace');
  const open = page.getByRole('button', {name: 'Open workspace navigation'});
  const trigger = page.getByRole('button', {name: 'Alex, Example workspace. Account menu', exact: true});
  const account = page.getByRole('group', {name: 'Account details', exact: true});
  const sidebar = page.getByRole('complementary', {name: 'Workspace', exact: true});
  await open.click();
  await sidebar.getByRole('link', {name: 'OpenCrawl home'}).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(account).toBeVisible();
  await page.getByRole('button', {name: 'Sign out', exact: true}).focus();
  await page.keyboard.press('Escape');
  await expect(account).not.toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sidebar).not.toBeVisible();
  await expect(open).toBeFocused();
});


test('local account setup uses the shared React form and submits the private bootstrap grant',async({page})=>{
  await page.setViewportSize({width:390,height:780});
  await page.goto('/auth-fixture/setup');
  await expect(page.getByRole('heading',{name:'Set up OpenCrawl'})).toBeVisible();
  await page.getByLabel('Workspace name').fill('Local team');
  await page.getByLabel('Your name').fill('Local admin');
  await page.getByLabel('Email',{exact:true}).fill('local@example.com');
  await page.getByLabel('Password (10+ characters)').fill('a private password');
  await expect(page.getByLabel('Password (10+ characters)')).toHaveAttribute('type','password');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.route('**/auth/signup',route=>route.fulfill({status:200,contentType:'text/plain',body:'Submitted'}));
  const posted=page.waitForRequest(request=>new URL(request.url()).pathname==='/auth/signup');
  await page.getByRole('button',{name:'Create workspace'}).click();
  const fields=new URLSearchParams((await posted).postData()||'');
  expect(fields.get('setup')).toBe('private-once-only');expect(fields.get('email')).toBe('local@example.com');
});

test('React OAuth consent identifies the client, resource and scopes and submits an explicit denial',async({page})=>{
  await page.goto('/auth-fixture/consent');
  await expect(page.getByRole('heading',{name:'Allow Example MCP client to use OpenCrawl?'})).toBeVisible();
  await expect(page.getByText('https://oss.example/mcp')).toBeVisible();
  await expect(page.getByText('openid, offline_access')).toBeVisible();
  await page.route('**/auth/consent',route=>route.fulfill({status:200,contentType:'text/plain',body:'Denied'}));
  const posted=page.waitForRequest(request=>new URL(request.url()).pathname==='/auth/consent');
  await page.getByRole('button',{name:'Deny',exact:true}).click();
  const fields=new URLSearchParams((await posted).postData()||'');
  expect(fields.get('accept')).toBe('false');expect(fields.get('oauth_query')).toBe('signed-consent-query');
});


test('self-host onboarding exposes private invitation links without claiming email delivery',async({page,request})=>{
  await request.post('/__test/reset',{data:{status:complete,sources:connected,invitations:[{email:'teammate@example.com',inviteUrl:'https://oss.example/auth/signup?invitation=private-grant'}]}});
  await page.goto('/onboarding/invite');
  await expect(page.getByLabel('Private invitation link',{exact:true})).toHaveValue('https://oss.example/auth/signup?invitation=private-grant');
  await expect(page.getByRole('button',{name:'Copy Private invitation link'})).toBeVisible();
  await expect(page.getByText('Invitation sent.')).toHaveCount(0);
});
