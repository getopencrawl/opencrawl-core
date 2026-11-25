import {test, expect} from '@playwright/test';
import type {Bootstrap} from '../src/application/api.ts';

const bootstrap:Bootstrap={cacheScope:'cli-setup-test',workspace:{name:'Disposable workspace',userName:'Alex',email:'alex@example.com',role:'admin'},mcpUrl:'https://disposable.example/mcp',setupPrompt:'',canInvite:true,onboarding:{completed:false,next:'/onboarding'},setup:{schemaVersion:1,scope:{tenantId:'workspace',userId:'alex'},firstWin:null,installations:[]}};
const installer = "curl -fsSL https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.sh | sh -s -- --connect --api 'https://disposable.example'";
const copyLabel = 'Copy setup command';

for(const viewport of [{width:1280,height:800},{width:390,height:844}])test(`incomplete CLI setup permits navigation and history at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);
  let reads = 0;
  await page.route('**/api/console/bootstrap',route=>{reads++;return route.fulfill({json:bootstrap});});
  await page.goto('/setup?full-app');
  await expect(page.getByRole('heading',{name:'Setup',exact:true})).toBeVisible();
  const command = page.getByRole('button',{name:copyLabel,exact:true}).locator('code');
  await expect(command).toHaveText(installer);
  await page.evaluate(() => document.fonts.ready);
  expect(await command.evaluate(field => field.scrollHeight <= field.clientHeight + 1 && field.scrollWidth <= field.clientWidth + 1)).toBe(true);
  await expect(page.getByRole('heading', {name:'Connect your first computer'})).toBeVisible();
  await expect(page.getByText('Waiting for your first computer', {exact:false})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Your computers'})).toBeVisible();
  const tabs = page.getByRole('tablist', {name:'Operating system'});
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(tabs.getByRole('tab', {name:'macOS / Linux'})).toHaveAttribute('aria-selected','true');
  await tabs.getByRole('tab', {name:'Windows'}).click();
  await expect(command).toContainText('install.ps1 | iex');
  await expect(command).toContainText('opencrawl login --api https://disposable.example');
  await expect(command).toContainText('opencrawl collect install --api https://disposable.example');
  await tabs.getByRole('tab', {name:'macOS / Linux'}).click();
  await expect(command).toHaveText(installer);
  expect(reads).toBe(1);
  let documents=0;page.on('request',request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())documents++;});
  if(viewport.width<600)await page.getByRole('button',{name:'Open workspace navigation'}).click();
  await page.getByRole('navigation',{name:'Workspace navigation'}).getByRole('link',{name:'Sessions',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sessions',exact:true})).toBeVisible();
  await page.goBack();await expect(page.getByRole('heading',{name:'Setup',exact:true})).toBeVisible();
  await page.goForward();await expect(page.getByRole('heading',{name:'Sessions',exact:true})).toBeVisible();
  expect(documents).toBe(0);
});

test('searchable capture alone stays pending until native Claude MCP is verified',async({page})=>{
  const data=structuredClone(bootstrap);
  data.setup!.installations=[{installationId:'install',machine:{id:'machine',label:'Test Mac'},updatedAt:'2026-11-17T12:00:00Z',clients:[{client:'claude-code',installed:true,pluginState:'installed',forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'not_required',mcp:{state:'observed'},proof:{state:'verified'},humanTasks:[]}]}];
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:data}));
  await page.goto('/setup?full-app');
  const tile = page.getByRole('listitem').filter({has:page.getByRole('heading', {name:'Test Mac'})});
  await expect(tile).toContainText('Awaiting sign-in');
  await expect(tile).toContainText('Captured and searchable');

  await expect(tile).toContainText('Claude Code');
  data.setup!.installations[0]!.clients[0]!.mcp.state='authenticated';
  await expect(tile.getByText('Connected',{exact:true})).toBeVisible({timeout:6000});
  data.setup!.installations[0]!.clients = [];
  data.setup!.installations[0]!.updatedAt = new Date().toISOString();
  await expect(tile).toContainText('No connected agents',{timeout:6000});

});

test('computer tiles show connected agent names and allow connecting another agent', async ({page}) => {
  const data = structuredClone(bootstrap);
  const client: NonNullable<Bootstrap['setup']>['installations'][number]['clients'][number] = {
    client: 'codex', installed: true, forward: true, history: 'import',
    historyProgress: {state: 'failed', completed: 0}, hookTrust: 'trusted',
    mcp: {state: 'authenticated'}, proof: {state: 'verified'}, humanTasks: [],
  };
  const laptop = {installationId: 'one', machine: {id: 'one', label: 'Development laptop'}, updatedAt: '2026-11-17T12:00:00Z'};
  const desktop = {installationId: 'two', machine: {id: 'two', label: 'Office desktop'}, updatedAt: laptop.updatedAt};
  data.setup!.installations = [
    {...laptop, clients: [client, {...client, client: 'cursor', history: 'skip', forward: false, mcp:{state:'observed'}}]},
    {...desktop, clients: [{...client, history: 'skip'}]},
    {...desktop, installationId: 'history', machine: {id:'history', label:'Archive Mac'},
      clients: [{...client, installed:false, forward:false, pluginState:'not_selected', historyProgress:{state:'complete', completed:3}}]},
    {...desktop, installationId: 'three', machine: {id: 'three', label: 'Unused machine'},
      clients: [{...client, installed: false, forward: false, history: 'skip', pluginState: 'not_selected'}]},
  ];
  await page.route('**/api/console/bootstrap', route => route.fulfill({json: data}));
  await page.goto('/setup?full-app');
  const computers = page.getByRole('list', {name:'Computers'});
  const tiles = computers.getByRole('listitem');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(0).getByRole('rowheader')).toContainText(['Codex', 'Cursor']);
  await expect(tiles.nth(1)).toContainText('Codex');
  for (const tile of [tiles.nth(2), tiles.nth(3)]) {
    await expect(tile).toContainText('No connected agents');
    await expect(tile).not.toContainText('Codex');
  }
  await expect(computers.locator('details, button')).toHaveCount(0);
  const addHost = page.getByText('Connect another computer',{exact:true});
  const heading = page.getByRole('heading',{name:'Your computers'});
  for (const width of [1280, 900, 390, 320]) {
    await page.setViewportSize({width, height:850});
    expect((await addHost.boundingBox())!.y).toBeLessThan((await heading.boundingBox())!.y);
    expect(await tiles.evaluateAll(items => items.every(el => el.scrollWidth <= el.clientWidth + 1))).toBe(true);
  }
  await page.setViewportSize({width:1280,height:800});
  const command = page.getByRole('button',{name:copyLabel});
  await expect(command).toBeHidden();
  await addHost.focus();
  await addHost.press('Enter');
  await expect(command.locator('code')).toHaveText(installer);
  await expect(command).toBeVisible();
  await page.getByRole('tab',{name:'Windows'}).click();
  await expect(command.locator('code')).toContainText('install.ps1');
  await addHost.click();
  await expect(command).toBeHidden();
  await expect(computers).toBeVisible();
});

test('computer headers show only the computer name while agent contact ages independently', async ({page}) => {
  const start = new Date('2026-11-19T12:00:00Z');
  await page.clock.install({time:start});
  const data = structuredClone(bootstrap);
  const connected: NonNullable<Bootstrap['setup']>['installations'][number]['clients'][number] = {
    client:'codex', installed:true, forward:true, history:'skip', historyProgress:{state:'not_started',completed:0},
    hookTrust:'trusted', mcp:{state:'authenticated'}, proof:{state:'verified'}, humanTasks:[],
  };
  const computer = (id:string, updatedAt:string) => ({installationId:id, machine:{id,label:id}, updatedAt, clients:[{...connected, lastSeenAt:updatedAt}]});
  const recent = computer('Laptop', '2026-11-19T11:46:00Z');
  data.setup!.installations = [recent, computer('Desktop', '2026-11-17T12:00:00Z')];
  await page.route('**/api/console/bootstrap', route => route.fulfill({json:data}));
  await page.goto('/setup?full-app');
  const tile = (name:string) => page.getByRole('listitem').filter({has:page.getByRole('heading', {name})});
  await expect(tile('Laptop').locator('header')).toHaveText('Laptop');
  await expect(tile('Desktop').locator('header')).toHaveText('Desktop');
  const contact = tile('Laptop').locator('.oc-host-last-contact');
  await expect(contact).toHaveText('Last contact 14 minutes ago');
  await expect(contact).toHaveAttribute('data-recent', 'true');
  await page.clock.fastForward(60_000);
  await expect(contact).toHaveText('Last contact 15 minutes ago');
  await expect(contact).toHaveAttribute('data-recent', 'false');
  recent.clients[0]!.lastSeenAt = '2026-11-19T12:01:00Z';
  await page.clock.runFor(3_100);
  await expect(contact).toHaveText('Last contact just now');
  await expect(contact.locator('time')).toHaveAttribute('datetime', recent.clients[0]!.lastSeenAt);
  await expect(contact.locator('time')).toHaveAttribute('title', /^Last contact from Codex at /);
  await expect(contact).toHaveAttribute('data-recent', 'true');
  await expect(tile('Desktop').locator('time')).toHaveText('2 days ago');
});

test('connected agent types on the same computer have independent last-seen indicators', async ({page}) => {
  await page.clock.install({time:new Date('2026-11-19T12:00:00Z')});
  const data = structuredClone(bootstrap);
  const client: NonNullable<Bootstrap['setup']>['installations'][number]['clients'][number] = {
    client:'codex', installed:true, forward:true, history:'skip', historyProgress:{state:'not_started',completed:0},
    hookTrust:'trusted', mcp:{state:'authenticated'}, proof:{state:'verified'}, humanTasks:[], lastSeenAt:'2026-11-19T11:46:00Z',
  };
  const laptop = {installationId:'laptop', machine:{id:'laptop',label:'Laptop'}, updatedAt:'2026-11-19T12:00:00Z',
    clients:[client, {...client, client:'claude-code' as const, lastSeenAt:'2026-11-19T10:00:00Z'},
      {...client, client:'cursor' as const, lastSeenAt:undefined, forward:false, mcp:{state:'observed' as const}}]};
  data.setup!.installations = [laptop];
  await page.route('**/api/console/bootstrap', route => route.fulfill({json:data}));
  await page.goto('/setup?full-app');
  const row = (name:string) => page.getByRole('row').filter({has:page.getByRole('rowheader',{name:new RegExp(name)})});
  await expect(row('Codex').locator('time')).toHaveText('14 minutes ago');
  await expect(row('Codex').locator('.oc-host-last-contact')).toHaveAttribute('data-recent','true');
  await expect(row('Claude Code').locator('.oc-host-last-contact')).toHaveAttribute('data-recent','false');
  await expect(row('Cursor')).toContainText('No signal yet');
  await page.clock.fastForward(60_000);
  await expect(row('Codex').locator('.oc-host-last-contact')).toHaveAttribute('data-recent','false');
  laptop.clients[1]!.lastSeenAt = '2026-11-19T12:01:00Z';
  await page.clock.runFor(3_100);
  await expect(row('Claude Code').locator('.oc-host-last-contact')).toHaveAttribute('data-recent','true');
  await expect(row('Claude Code').locator('time')).toHaveText('just now');
  await expect(row('Codex').locator('time')).toHaveText('15 minutes ago');
  await expect(row('Cursor').locator('.oc-host-last-contact')).not.toHaveAttribute('data-recent');
});

test('Setup and Integrations keep their sidebar positions before bootstrap and through retry', async ({page}) => {
  let release = () => {};
  const pending = new Promise<void>(resolve => {release = resolve;});
  let fail = true;
  await page.route('**/api/console/bootstrap', async route => {
    await pending;
    await route.fulfill(fail ? {status:503, json:{error:'Workspace unavailable'}} : {json:bootstrap});
  });
  try {
    await page.goto('/setup?full-app&role=admin');
    const integrations = page.getByRole('link', {name:'Integrations', exact:true});
    await expect(integrations).toBeVisible();
    const position = await integrations.boundingBox();
    const first = page.getByRole('navigation', {name:'Workspace navigation'}).getByRole('link').first();
    await expect(first).toHaveText('Setup');
    await expect(first).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', {name:'Setup', exact:true})).toBeVisible();
    const top = await first.boundingBox();
    release();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(first).toHaveText('Setup');
    expect(await integrations.boundingBox()).toEqual(position);
    fail = false;
    await page.getByRole('button', {name:'Try again'}).click();
    await expect(page.getByRole('button', {name:copyLabel}).locator('code')).toHaveText(installer);
    await expect(first).toHaveAccessibleName('Setup Needs attention. No computers connected.');
    expect((await first.boundingBox())?.y).toBe(top?.y);
    expect(await integrations.boundingBox()).toEqual(position);
  } finally {release();}
});

test('a completed Replicas import leads to workspace capture setup',async({page})=>{
  let issued=0;
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{...bootstrap,canInstallReplicas:true}}));
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[{provider:'replicas',name:'Replicas',state:'synced',auth:'api-key',scope:'team',total:1,synced:1}]}}));
  await page.route('**/api/console/replicas/setup',route=>{
    expect(route.request().method()).toBe('POST');issued++;
    return route.fulfill({json:{prompt:'One-time fixture prompt for Replicas',expiresAt:new Date(Date.now()+1800000).toISOString()}});
  });
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Clipboard denied');}}}));
  await page.goto('/sources?full-app');
  await page.getByRole('article',{name:'Replicas'}).getByRole('link',{name:'Set up capture'}).click();
  await expect(page).toHaveURL(/\/sources#replicas-capture$/);
  await expect(page.getByRole('dialog',{name:'Record new Replicas chats'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Replicas capture guide'})).toHaveAttribute('href','https://docs.getopencrawl.com/agents/replicas-capture/');
  expect(issued).toBe(0);
  await page.getByRole('button',{name:'Install on Replicas'}).click();
  await expect(page.getByRole('textbox',{name:'Prompt to copy'})).toHaveValue('One-time fixture prompt for Replicas');
  expect(issued).toBe(1);
  await page.getByRole('button',{name:'I’ve copied it'}).click();
  await expect(page.getByRole('button',{name:'Copied',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Close dialog'}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an admin can start capture before importing history and from published setup links',async({page})=>{
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{...bootstrap,canInstallReplicas:true}}));
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[{provider:'replicas',name:'Replicas',state:'disconnected',auth:'api-key',scope:'team'}]}}));
  await page.goto('/setup?full-app');
  await expect(page.getByRole('button',{name:copyLabel})).toBeVisible();
  await expect(page.getByText(/Replicas/)).toHaveCount(0);
  await page.getByRole('navigation',{name:'Workspace navigation'}).getByRole('link',{name:'Integrations'}).click();
  const card=page.getByRole('article',{name:'Replicas'});
  await expect(card.getByRole('button',{name:'Connect Replicas'})).toBeVisible();
  await card.getByRole('link',{name:'Set up capture'}).click();
  await expect(page.getByRole('button',{name:'Install on Replicas'})).toBeVisible();
  for (const path of ['/setup','/agent-setup']) {
    await page.goto(path+'?full-app#replicas-capture');
    await expect(page).toHaveURL(/\/sources#replicas-capture$/);
    await expect(page.getByRole('dialog',{name:'Record new Replicas chats'})).toBeVisible();
  }
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{...bootstrap,workspace:{...bootstrap.workspace,role:'member'}}}));
  await page.goto('/sources?full-app#replicas-capture');
  await expect(page.getByRole('heading',{name:'Usage',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Install on Replicas'})).toHaveCount(0);
});

test('the welcome becomes a host report and verifies capture separately for each agent',async({page})=>{
  const data=structuredClone(bootstrap);
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:data}));
  await page.goto('/setup?full-app');
  await expect(page.getByRole('heading',{name:'Welcome to OpenCrawl'})).toBeVisible();
  const illustration = page.locator('.oc-host-welcome img');
  const steps = page.getByRole('list',{name:'Setup steps'}).getByRole('listitem');
  await expect(illustration).toBeVisible();
  await expect(steps).toHaveCount(3);
  const setupBadge=page.getByRole('navigation',{name:'Workspace navigation'}).getByRole('img',{name:'Needs attention. No computers connected.'});
  await expect(setupBadge).toBeVisible();
  const codex:NonNullable<Bootstrap['setup']>['installations'][number]['clients'][number]={
    client:'codex',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},
    hookTrust:'trusted',mcp:{state:'authenticated'},proof:{state:'waiting_index'},captureObservedAt:new Date().toISOString(),humanTasks:[],
  };
  data.setup!.installations.push({installationId:'office',machine:{id:'office',label:'Office Mac'},updatedAt:new Date().toISOString(),
    clients:[codex,{...codex,client:'cursor',forward:false,proof:{state:'not_selected'},captureObservedAt:undefined}]});
  const host = page.getByRole('heading',{name:'Office Mac'});
  const addHost = page.getByText('Connect another computer',{exact:true});
  await expect(host).toBeInViewport({timeout:6500});
  await expect(illustration).toHaveCount(0);
  await expect(addHost).toBeVisible();
  await expect(steps).toHaveCount(0);
  await expect(setupBadge).toHaveCount(0);
  const codexRow=page.getByRole('row').filter({hasText:'Codex'});
  const cursorRow=page.getByRole('row').filter({hasText:'Cursor'});
  await expect(codexRow).toContainText('Captured, awaiting search');
  await expect(cursorRow).toContainText('Recording off');
  await expect(page.getByRole('link',{name:'View sessions'})).toHaveCount(0);
  codex.proof={state:'verified'};
  await expect(codexRow).toContainText('Captured and searchable',{timeout:6500});
  await expect(host).toBeInViewport();
  await expect(steps).toHaveCount(0);
  await addHost.click();
  await expect(steps).toHaveCount(3);
  await expect(cursorRow).toContainText('Recording off');
  await expect(page.getByRole('link',{name:'View sessions'})).toHaveCount(0);
});
