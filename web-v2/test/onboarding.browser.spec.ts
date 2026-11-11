import {test, expect, type Page} from '@playwright/test';
import type {} from './fixtures/onboarding-app.tsx';

const receipt = {observedAt: '2026-11-07T12:00:00.000Z'};
const complete = {cli: receipt, mcpTest: receipt, session: receipt};
const connected = [{id: 'slack', name: 'Slack', icon: '/assets/connectors/slack.svg', state: 'syncing', auth: 'oauth'}];

test.beforeEach(async ({request}) => {await request.post('/__test/reset', {data: {}});});

for (const viewport of [{name: 'desktop', width: 1280, height: 813}, {name: 'mobile', width: 390, height: 844}]) {
  test(`Agent setup stays in the workspace with uniform navigation spacing on ${viewport.name}`, async ({page, request}, testInfo) => {
    await request.post('/__test/state', {data: {status: complete}});
    await page.setViewportSize(viewport);
    await page.goto('/workspace');
    let documents = 0;
    page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;});
    if (viewport.name === 'mobile') await page.getByRole('button', {name: 'Open workspace navigation'}).click();
    const navigation = page.getByRole('navigation', {name: 'Workspace navigation'});
    const gaps = await navigation.getByRole('link').evaluateAll(links => links.slice(1).map((link, index) => link.getBoundingClientRect().top - links[index]!.getBoundingClientRect().bottom));
    expect(gaps).toEqual([4, 4]);
    await navigation.getByRole('link', {name: 'Agent setup', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Agent setup', exact: true})).toBeFocused();
    await expect(page.getByRole('heading', {name: 'Connect your primary coding agent'})).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('navigation', {name: 'Onboarding steps'})).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveAttribute('data-onboarding');
    await page.getByRole('button', {name: 'Show setup prompt'}).click();
    await expect(page.locator('#connect-preview')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: testInfo.outputPath(`agent-setup-${viewport.name}.png`), fullPage: true});
    await page.goBack();
    await expect(page.getByRole('heading', {name: 'Console home'})).toBeVisible();
    await page.goForward();
    await expect(page.getByRole('heading', {name: 'Agent setup', exact: true})).toBeVisible();
    expect(documents).toBe(0);
  });
}

test('unconfigured OSS connectors remain visible and explain setup without starting OAuth',async({page,request})=>{
  await request.post('/__test/state',{data:{status:complete,sources:[
    {id:'googledrive',name:'Google Drive',state:'setup-required',setup:{title:'Set up Google Drive',body:'Ask your administrator to configure COMPOSIO_API_KEY.'}},
    {id:'granola',name:'Granola',state:'disconnected',auth:'api-key'},
  ]}});
  let connections=0;page.on('request',r=>{if(r.url().includes('/api/integrations/'))connections++;});
  await page.goto('/onboarding/sources');
  await page.getByRole('button',{name:'Set up Google Drive',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Set up Google Drive'})).toBeVisible();
  await expect(page.getByText('Ask your administrator to configure COMPOSIO_API_KEY.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Connect Granola',exact:true})).toBeVisible();
  expect(connections).toBe(0);
});

for(const viewport of [{name:'desktop',width:1280,height:813},{name:'mobile',width:390,height:844}]){
  test(`setup-required notes stay attached to compact connector tiles at ${viewport.name} width`,async({page,request})=>{
    const setup=(id:string,name:string)=>({id,name,state:'setup-required',setup:{title:`Set up ${name}`,body:'Ask your administrator to configure this connection.'}});
    await request.post('/__test/state',{data:{status:complete,sources:[setup('googledrive','Google Drive'),setup('slack','Slack'),{id:'granola',name:'Granola',state:'disconnected',auth:'api-key'},setup('circleback','Circleback'),setup('notion','Notion'),setup('github','GitHub')]}});
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    await page.goto('/onboarding/sources');
    await expect(page.getByText('Setup required',{exact:true})).toHaveCount(5);
    await page.evaluate(()=>document.fonts.ready);
    const cells=await page.locator('.connector-cell').evaluateAll(nodes=>nodes.map(node=>{
      const tile=node.querySelector('.connector-tile')?.getBoundingClientRect();
      const note=[...node.querySelectorAll('p')].find(text=>text.textContent==='Setup required')?.getBoundingClientRect();
      return {cell:node.getBoundingClientRect().height,tile:tile?.height??0,gap:note&&tile?note.top-tile.bottom:null,note:note?.height??null};
    }));
    expect(cells).toHaveLength(6);
    expect(cells.filter(cell=>cell.gap!==null)).toHaveLength(5);
    for(const cell of cells){
      expect(cell.tile).toBe(viewport.name==='mobile'?56:64);
      // One caption directly under its tile, never the catalog's full-height state block.
      expect(cell.cell).toBeLessThanOrEqual(cell.tile+32);
      if(cell.gap===null||cell.note===null)continue;
      expect(cell.gap).toBeGreaterThanOrEqual(4);expect(cell.gap).toBeLessThanOrEqual(12);
      expect(cell.note).toBeLessThanOrEqual(24);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

const composio={id:'composio',name:'Composio',label:'Composio API key',url:'https://dashboard.composio.dev/~/project/settings/api-keys',help:'The key is stored encrypted on this instance.',unlocks:['Google Drive','Notion']};
const waiting=(id:string,name:string)=>({id,name,state:'setup-required',auth:'oauth',setup:{title:`Set up ${name}`,body:`${name} signs in through Composio.`,requirement:'Needs a Composio key',credential:composio}});
const locked=[waiting('googledrive','Google Drive'),{id:'granola',name:'Granola',state:'disconnected',auth:'api-key'},waiting('notion','Notion'),{id:'github',name:'GitHub',state:'setup-required',setup:{title:'Set up GitHub',body:'Configure a GitHub App on the server.',requirement:'Needs a GitHub App'}}];

test('an admin adds the operator key from the Sources step and continues into sign-in',async({page,request})=>{
  await request.post('/__test/state',{data:{status:complete,sources:locked}});
  await page.route('https://provider.example/authorize',route=>route.fulfill({contentType:'text/html',body:'<h1>Provider authorization fixture</h1>'}));
  await page.goto('/onboarding/sources');
  // Connectors that can start come first; the rest say what they are waiting for.
  await expect(page.getByRole('list',{name:'Ready to connect'}).getByRole('button')).toHaveText(['Granola']);
  await expect(page.getByRole('list',{name:'Needs one-time setup'}).getByRole('button')).toHaveText(['Google Drive','Notion','GitHub']);
  await expect(page.getByText('One Composio key unlocks Google Drive and Notion.')).toBeVisible();
  await expect(page.getByText('Needs a Composio key',{exact:true})).toHaveCount(2);
  await expect(page.getByText('Needs a GitHub App',{exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'Set up GitHub',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Set up GitHub'})).toContainText('Configure a GitHub App on the server.');
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button',{name:'Set up Google Drive',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Set up Google Drive'});
  await expect(dialog.getByLabel('Composio API key')).toBeFocused();
  await expect(dialog.getByLabel('Composio API key')).toHaveAttribute('type','password');
  await expect(dialog.getByRole('link',{name:'Get a key from Composio'})).toHaveAttribute('href',composio.url);
  await expect(dialog.getByRole('button',{name:'Save key and connect Google Drive'})).toBeDisabled();
  await dialog.getByLabel('Composio API key').fill('wrong-key');
  await dialog.getByRole('button',{name:'Save key and connect Google Drive'}).click();
  await expect(dialog.getByRole('alert')).toContainText('Composio did not accept that key.');
  await expect(dialog.getByLabel('Composio API key')).toHaveValue('wrong-key');
  await dialog.getByLabel('Composio API key').fill('accepted-key');
  await dialog.getByLabel('Composio API key').press('Enter');
  // Saving unlocks the connector and carries straight on into the provider's sign-in.
  await expect(page).toHaveURL('https://provider.example/authorize');
  const state=await (await request.get('/__test/state')).json() as {requests:{credential:number;connect:number};sources:{id:string;state:string;setup?:unknown}[]};
  expect(state.requests).toMatchObject({credential:2,connect:1});
  expect(state.sources.filter(source=>source.setup).map(source=>source.id)).toEqual(['github']);
});

test('a member is told to ask an admin instead of being shown the key form',async({page,request})=>{
  await request.post('/__test/state',{data:{status:complete,sources:locked}});
  await page.goto('/onboarding/sources?role=member');
  await page.getByRole('button',{name:'Set up Notion',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Set up Notion'});
  await expect(dialog).toContainText('Ask a workspace admin to add the Composio key.');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button',{name:/Save key/})).toHaveCount(0);
  expect(((await (await request.get('/__test/state')).json()) as {requests:{credential:number}}).requests.credential).toBe(0);
});

test('the Integrations page takes the operator key and opens sign-in in the reserved window',async({page,request,context})=>{
  await request.post('/__test/state',{data:{status:complete,sources:locked}});
  await context.route('https://provider.example/authorize',route=>route.fulfill({contentType:'text/html',body:'<h1>Provider authorization fixture</h1>'}));
  await page.goto('/integrations-fixture');
  await expect(page.getByRole('status').filter({hasText:'One Composio key unlocks Google Drive and Notion.'})).toBeVisible();
  const notion=page.getByRole('article',{name:'Notion'});
  await expect(notion.locator('.oc-connector-footer > span')).toHaveAttribute('title','Needs a Composio key.');
  await notion.getByRole('button',{name:'Set up Notion'}).click();
  const dialog=page.getByRole('dialog',{name:'Set up Notion'});
  await dialog.getByLabel('Composio API key').fill('accepted-key');
  const popup=page.waitForEvent('popup');
  await dialog.getByRole('button',{name:'Save key and connect Notion'}).click();
  await expect((await popup).getByRole('heading',{name:'Provider authorization fixture'})).toBeVisible();
  await expect(dialog).not.toBeVisible();
  // The other connector that was waiting for the same key is now ready as well.
  await expect(page.getByRole('article',{name:'Google Drive'}).getByRole('button',{name:'Connect Google Drive'})).toBeVisible();
  await expect(page.getByText('One Composio key unlocks')).toHaveCount(0);
});

test('members can inspect shared integrations without mutation controls',async({page,request})=>{
  await request.post('/__test/state',{data:{status:complete,sources:[
    {id:'slack',name:'Slack',scope:'team',state:'synced',auth:'oauth'},
    {id:'notion',name:'Notion',scope:'team',state:'disconnected',auth:'oauth'},
    {id:'granola',name:'Granola',scope:'team',state:'error',auth:'api-key'},
  ]}});
  await page.goto('/integrations-fixture?role=member');
  await expect(page.getByText('Workspace admins manage shared integrations.',{exact:true})).toBeVisible();
  await expect(page.getByRole('article',{name:'Slack'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Disconnect|Connect Notion|Retry sync/})).toHaveCount(0);
  await page.goto('/onboarding/sources?role=member');
  await expect(page.getByRole('button',{name:'Connect Notion',exact:true})).toHaveAttribute('aria-disabled','true');
  await expect(page.getByRole('link',{name:'Next',exact:true})).toBeVisible();
  expect(((await (await request.get('/__test/state')).json()) as {requests:{connect:number}}).requests.connect).toBe(0);
});

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
  await expect(page.getByRole('link', {name: 'Skip for now', exact: true})).toBeVisible();
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
  await expect(page.getByRole('link', {name: 'Skip for now', exact: true})).toHaveCount(0);
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

test('sources are optional: Skip for now reaches teammates and finishes without a connection', async ({page, request}) => {
  let documentLoads = 0;
  page.on('request', request => {if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentLoads++;});
  await request.post('/__test/state', {data: {status: complete}});
  await page.goto('/onboarding/sources');
  await expect(page.getByText('Connect a source to give your agent more context. You can also add one later.')).toBeVisible();
  const skip = page.getByRole('link', {name: 'Skip for now', exact: true});
  await expect(skip).toHaveClass(/onboarding-skip/);
  await expect(page.getByRole('link', {name: 'Next', exact: true})).toHaveCount(0);
  await skip.click();
  await expect(page.getByRole('heading', {name: 'Invite your teammates'})).toBeVisible();
  await page.getByRole('button', {name: 'Skip for now'}).click();
  await expect(page.getByRole('heading', {name: 'Workspace overview'})).toBeVisible();
  expect(documentLoads).toBe(1);
  const state = await (await request.get('/__test/state')).json() as {requests: {finish: number; connect: number}};
  expect(state.requests).toMatchObject({finish: 1, connect: 0});
});

test('a catalog that fails to load still lets setup continue', async ({page, request}) => {
  await request.post('/__test/state', {data: {status: complete, sourcesError: true}});
  await page.goto('/onboarding/sources');
  await expect(page.getByRole('alert')).toHaveText('We couldn’t load your connectors.');
  await page.getByRole('link', {name: 'Skip for now', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Invite your teammates'})).toBeVisible();
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
