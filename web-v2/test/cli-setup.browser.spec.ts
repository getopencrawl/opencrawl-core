import {test, expect} from '@playwright/test';
import type {Bootstrap} from '../src/application/api.ts';

const bootstrap:Bootstrap={cacheScope:'cli-setup-test',workspace:{name:'Disposable workspace',userName:'Alex',email:'alex@example.com',role:'admin'},mcpUrl:'https://disposable.example/mcp',setupPrompt:'',canInvite:true,onboarding:{completed:false,next:'/onboarding'},setup:{schemaVersion:1,scope:{tenantId:'workspace',userId:'alex'},firstWin:null,installations:[]}};
const installer = 'curl -fsSL https://raw.githubusercontent.com/getopencrawl/opencrawl-core/main/cli/install.sh | sh -s -- --setup';
const terminalLabel = 'Run in Terminal on the Mac you want to connect';

for(const viewport of [{width:1280,height:800},{width:390,height:844}])test(`incomplete CLI setup permits navigation and history at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);
  let reads = 0;
  await page.route('**/api/console/bootstrap',route=>{reads++;return route.fulfill({json:bootstrap});});
  await page.goto('/setup?full-app');
  await expect(page.getByRole('heading',{name:'Setup',exact:true})).toBeVisible();
  await expect(page.getByRole('textbox',{name:terminalLabel,exact:true})).toHaveValue(installer);
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
  const machine = page.locator('summary').filter({hasText:'Test Mac'});
  await expect(machine).toContainText('0 of 1 ready');
  await machine.press('Enter');
  const details = page.getByRole('list', {name:'Agent setup on Test Mac'});
  await expect(details).toContainText('Captured and searchable');
  await expect(details).toContainText('Waiting for workspace connection');
  data.setup!.installations[0]!.clients[0]!.mcp.state='authenticated';
  await expect(machine).toContainText('1 of 1 ready',{timeout:6000});
  await expect(details).toContainText('Workspace connection verified');
});

test('existing machines stay compact, disclose checks, and can add another machine', async ({page}) => {
  const data = structuredClone(bootstrap);
  const client: NonNullable<Bootstrap['setup']>['installations'][number]['clients'][number] = {
    client: 'codex', installed: true, forward: true, history: 'import',
    historyProgress: {state: 'failed', completed: 0}, hookTrust: 'trusted',
    mcp: {state: 'authenticated'}, proof: {state: 'verified'}, humanTasks: [],
  };
  const laptop = {installationId: 'one', machine: {id: 'one', label: 'Development laptop'}, updatedAt: '2026-11-17T12:00:00Z'};
  const desktop = {installationId: 'two', machine: {id: 'two', label: 'Office desktop'}, updatedAt: laptop.updatedAt};
  data.setup!.installations = [
    {...laptop, clients: [client, {...client, client: 'cursor', history: 'skip', forward: false}]},
    {...desktop, clients: [{...client, history: 'skip'}]},
    {...desktop, installationId: 'history', machine: {id:'history', label:'Archive Mac'},
      clients: [{...client, installed:false, forward:false, pluginState:'not_selected', historyProgress:{state:'complete', completed:3}}]},
    {...desktop, installationId: 'three', machine: {id: 'three', label: 'Unused machine'},
      clients: [{...client, installed: false, forward: false, history: 'skip', pluginState: 'not_selected'}]},
  ];
  await page.route('**/api/console/bootstrap', route => route.fulfill({json: data}));
  await page.goto('/setup?full-app');
  const laptopSummary = page.locator('summary').filter({hasText: 'Development laptop'});
  await expect(laptopSummary).toContainText('Needs attention');
  const details = page.getByRole('list', {name:'Agent setup on Development laptop'});
  await expect(details).toBeHidden();
  await laptopSummary.press('Space');
  await expect(details).toContainText('Past session import needs attention in the CLI');
  await expect(details).toContainText('Recording off');
  for (const width of [1280, 900, 390, 320]) {
    await page.setViewportSize({width, height: 850});
    expect(await laptopSummary.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(details).toBeVisible();
  }
  await expect(page.locator('summary').filter({hasText:'Unused machine'})).toContainText('No agents selected');
  const archive = page.locator('summary').filter({hasText:'Archive Mac'});
  await expect(archive).toContainText('History only');
  await archive.press('Enter');
  await expect(page.getByRole('list', {name:'Agent setup on Archive Mac'})).toContainText('Past sessions imported');
  await page.getByRole('button', {name:'Add machine', exact:true}).click();
  const dialog = page.getByRole('dialog', {name:'Add a machine'});
  await expect(dialog.getByRole('textbox',{name:terminalLabel})).toHaveValue(installer);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', {name:'Add machine', exact:true})).toBeFocused();
  await expect(details).toBeVisible();
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
    await expect(page.getByRole('textbox', {name:terminalLabel})).toHaveValue(installer);
    await expect(first).toHaveText('Setup');
    expect((await first.boundingBox())?.y).toBe(top?.y);
    expect(await integrations.boundingBox()).toEqual(position);
  } finally {release();}
});
