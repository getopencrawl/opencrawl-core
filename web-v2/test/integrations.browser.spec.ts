import {test, expect} from '@playwright/test';
import type {SourceCard} from '../src/application/api.ts';

const source = (index:number):SourceCard => ({provider:`example-${index}`,name:`Example connector ${String(index).padStart(2,'0')}`,auth:'oauth',scope:'team',state:index%4===0?'disconnected':'synced',description:'Shared workspace content.',account:index%4===0?null:'Example workspace',synced:index*100,rows:index%4===0?undefined:[{label:'Pages',count:index*100,done:true},{label:'Comments',count:index*150,done:true},{label:'Files',count:0,done:true}],primaryMetric:'Pages'});
const sources = Array.from({length:24},(_,i)=>source(24-i));
test.beforeEach(async({page,request})=>{
  await request.post('/__test/reset',{data:{}});
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:sources}}));
});
for (const viewport of [{width: 1920, height: 900}, {width: 1440, height: 900}, {width: 390, height: 844}, {width: 667, height: 375}]) {
  const mobile = viewport.width <= 800;
  test(`workspace header ${mobile ? 'scrolls with the page' : 'stays in place'} at ${viewport.width}px`, async ({page}) => {
    await page.setViewportSize(viewport);
    await page.goto('/integrations-fixture');
    const title = page.getByRole('heading', {level: 1, name: 'Integrations'});
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(sources.length);
    await page.evaluate(() => document.fonts.ready);
    const titleTop = () => title.evaluate(element => element.getBoundingClientRect().top);
    const initialTop = await titleTop();
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(viewport.height);
    const pane = mobile ? page.getByRole('main') : page.locator('.oc-page-scroll');
    const expectScrolledHeader = async () => {
      if (mobile) await expect(page.locator('main .oc-page-header')).not.toBeInViewport();
      else expect(await titleTop()).toBe(initialTop);
    };
    const box = await page.getByRole('main').boundingBox();
    if (!box) throw new Error('Expected a visible workspace');
    // Both outer margins of the workspace accept wheel input.
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBeGreaterThan(300);
    await expect(cards.first()).not.toBeInViewport();
    await expectScrolledHeader();

    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    await page.mouse.wheel(0, -500);
    await expect.poll(() => pane.evaluate(element => element.scrollTop)).toBe(0);
    expect(await titleTop()).toBe(initialTop);

    const lastAction = cards.last().getByRole('button', {name: 'Manage'});
    await lastAction.focus();
    await expect(lastAction).toBeInViewport();
    await expectScrolledHeader();
    if (mobile) {
      const menu = page.getByRole('button', {name: 'Open workspace navigation'});
      await expect(menu).toBeInViewport();
      const menuBounds = await menu.boundingBox();
      expect(menuBounds?.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeLessThanOrEqual(56);
      await menu.click();
      await expect(page.getByRole('navigation', {name: 'Workspace navigation'})).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
      await expect(lastAction).toBeInViewport();
    }
  });
}
for (const width of [1920, 1440, 390]) {
  test(`decorated pages follow the workspace header layout at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height: 844});
    await page.goto('/integrations-fixture');
    const title = page.getByRole('heading', {level: 1, name: 'Integrations'});
    const expectFullWidthHeader = async () => {
      const main = page.getByRole('main');
      const header = main.locator('.oc-page-header');
      const edges = (element: Element) => {
        const {left, right} = element.getBoundingClientRect();
        return {left, right};
      };
      await expect(header).toHaveCSS('border-bottom-width', '1px');
      expect(await header.evaluate(edges)).toEqual(await main.evaluate(edges));
      const body = await main.locator('.oc-page-body').evaluate(edges);
      expect(await title.evaluate(element => element.getBoundingClientRect().left)).toBe(body.left);
      expect(body.right - body.left).toBeLessThanOrEqual(1200);
    };
    const titleTop = () => title.evaluate(element => element.getBoundingClientRect().top);
    await expect(page.getByRole('article')).toHaveCount(sources.length);
    const baseline = await titleTop();
    await expectFullWidthHeader();

    await page.goto('/integrations-fixture?decorated');
    await expect(page.getByRole('article')).toHaveCount(sources.length);
    expect(await titleTop()).toBe(baseline);
    await expectFullWidthHeader();
    const terms = page.getByRole('link', {name: 'Connector terms'});
    await terms.focus();
    await expect(terms).toBeInViewport();
    await expect(page.getByRole('article').first()).not.toBeInViewport();
    if (width <= 800) await expect(page.locator('main .oc-page-header')).not.toBeInViewport();
    else {
      expect(await titleTop()).toBe(baseline);
      await expect(title).toBeInViewport({ratio: 1});
    }
  });
}
for(const width of [1440,600,390,320]) test(`available tiles precede connected cards and support search at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.goto('/integrations-fixture');
  const cards=page.getByRole('article');
  await expect(cards).toHaveCount(24);
  const available=page.getByRole('region',{name:'Available',exact:true});
  const connected=page.getByRole('region',{name:'Connected',exact:true});
  const connectedCards=connected.getByRole('article');
  const sorted=[...sources].reverse();
  expect(await cards.evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')))).toEqual([...sorted.filter(s=>s.state==='disconnected'),...sorted.filter(s=>s.state!=='disconnected')].map(s=>s.name));
  await expect(available.getByRole('article')).toHaveCount(6);
  await expect(available.getByRole('article').locator('p, footer, dl')).toHaveCount(0);
  await expect(available.getByRole('article').locator('.oc-integration-logo')).toHaveCount(6);
  expect(await available.getByRole('article').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height<120))).toBe(true);
  expect(await connectedCards.evaluateAll(es=>[...new Set(es.map(e=>e.getBoundingClientRect().height))])).toEqual([288]);
  await expect(connectedCards.locator('.oc-integration-header p')).toHaveCount(0);
  if(width<=600) expect(await connectedCards.locator('footer button').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().height>=44))).toBe(true);
  const first=connectedCards.first();
  const manage = first.getByRole('button', {name: /Manage/});
  const controlHeight = width <= 800 ? '44px' : '32px';
  await expect(manage).toHaveCSS('height', controlHeight);
  await expect(page.getByRole('searchbox', {name:'Search integrations'})).toHaveCSS('height', controlHeight);
  await expect(manage).toHaveCSS('border-radius', '4px');
  await expect(first).toHaveCSS('border-radius', '7px');
  await expect(manage).toHaveCSS('font-size', '14px');
  await expect(first.locator('.oc-integration-meta')).toHaveCSS('font-size', '15px');
  await expect(first.locator('.oc-integration-metrics li > span:last-child')).toHaveText(['100','150','0']);
  await expect(first.getByRole('button',{name:/Show/})).toHaveCount(0);
  await expect(first.locator('.oc-integration-breakdown')).not.toHaveAttribute('tabindex','0');
  await page.getByRole('searchbox',{name:'Search integrations'}).fill('connector 19');
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute('aria-label','Example connector 19');
  await page.getByRole('searchbox').fill('');
  await expect(cards).toHaveCount(24);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(connectedCards.locator('.oc-status-pill')).toHaveCount(0);
  await expect(connectedCards.locator('footer .oc-button.secondary')).toHaveCount(18);
});

test('recurring syncs show stream spinners and one footer status, and each logo has one frame', async ({page}) => {
  const providers = ['slack', 'notion', 'github', 'granola', 'circleback', 'linear', 'replicas'];
  const items: SourceCard[] = providers.map((provider, i) => ({
    ...source(i), provider, name: provider, state: 'syncing', initial: provider === 'replicas',
    total: 2100, synced: 2066, rows: [{label: 'Messages', count: 2066}, {label: 'Files', count: 0, done: true}],
  }));
  await page.route('**/api/console/sources', route => route.fulfill({json: {items}}));
  await page.goto('/integrations-fixture');
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(providers.length);
  for (const provider of providers) {
    const card = page.getByRole('article', {name: provider, exact: true});
    const logo = card.locator('.oc-integration-logo');
    await expect.poll(() => logo.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await expect(logo).toHaveCSS('width', '36px');
    await expect(logo).toHaveCSS('border-top-width', ['linear', 'replicas'].includes(provider) ? '1px' : '0px');
    await expect(card.locator('footer p')).toHaveText(provider === 'replicas' ? 'Importing' : 'Syncing');
    await expect(card.locator('.oc-spin')).toHaveCount(1);
  }
  const slack = page.getByRole('article', {name: 'slack', exact: true});
  await expect(slack.locator('.oc-source-message')).toHaveCount(0);
  await expect(slack.getByRole('listitem').first()).toContainText('Messages: Syncing');
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await slack.getByRole('button', {name: 'Manage slack'}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Syncing changes…');
  await expect(dialog).toContainText('Messages: Syncing');
  await expect(dialog.getByRole('progressbar')).toHaveCount(0);
});

test('small catalogs use only sections and hidden search cannot keep filtering',async({page})=>{
  await page.clock.install();
  let items=sources.slice(0,14);
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items}}));
  await page.goto('/integrations-fixture');
  await expect(page.getByRole('article')).toHaveCount(14);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Available',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Connected',exact:true})).toBeVisible();
  items=sources.slice(0,15);
  await page.clock.runFor(30_001);
  await page.getByRole('searchbox',{name:'Search integrations'}).fill('does not exist');
  await expect(page.getByRole('heading',{name:'No matching integrations'})).toBeVisible();
  items=sources.slice(0,6);
  await page.clock.runFor(30_001);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(6);
  await expect(page.getByRole('heading',{name:'No matching integrations'})).toHaveCount(0);
});

test('recovery dialogs preserve sign-in, sync and removal actions and member permissions',async({page})=>{
  const cases:SourceCard[]=[
    {...source(1),name:'Expired',state:'error',rows:undefined,synced:undefined,recoveryAction:'connect',message:'Authorization expired.'},
    {...source(2),name:'Sync failed',state:'error',recoveryAction:'sync',message:'Sync failed.'},
    {...source(3),name:'Removal failed',state:'error',recoveryAction:'disconnect',message:'Removal did not finish.'},
  ];
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:cases}}));
  await page.goto('/integrations-fixture');
  await expect(page.getByRole('article',{name:'Expired'})).toContainText('Authorization expired.');
  await page.getByRole('button',{name:'Fix connection Expired'}).click();
  let dialog=page.getByRole('dialog');
  await expect(dialog).toContainText('Authorization expired.');
  await expect(dialog.getByRole('button',{name:'Restart sign-in'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:/Disconnect|Retry/})).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Fix connection Sync failed'}).click();
  await expect(dialog.getByRole('button',{name:'Retry sync'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Fix connection Removal failed'}).click();
  await expect(dialog.getByRole('button',{name:'Retry removal'})).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Retry sync'})).toHaveCount(0);
  await page.goto('/integrations-fixture?role=member');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('article',{name:'Expired'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Restart sign-in|Retry|Disconnect/})).toHaveCount(0);
});

test('cards keep account context in Manage and directly open OAuth or required setup',async({page,context})=>{
  const connected={...source(1),name:'Connected source',account:'Example account',connectedBy:'admin@example.com'};
  const direct={...source(4),provider:'linear',name:'Linear'};
  const setup:SourceCard={...source(8),name:'Setup source',state:'setup-required',setup:{title:'Set up source',body:'Ask your administrator to configure this source.'}};
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[connected,direct,setup]}}));
  await page.goto('/integrations-fixture');
  const card=page.getByRole('article',{name:'Connected source',exact:true});
  await expect(card).not.toContainText('Example account');
  await expect(page.locator('.oc-integration-header p')).toHaveCount(0);
  await card.getByRole('button',{name:'Manage Connected source'}).click();
  await expect(page.getByRole('dialog')).toContainText('Example account');
  await expect(page.getByRole('dialog')).toContainText('Connected by admin@example.com');
  await page.keyboard.press('Escape');
  for(const name of ['Linear','Setup source']) await expect(page.getByRole('button',{name:`Connect ${name}`,exact:true})).toHaveClass(/\bprimary\b/);
  let connects=0;
  await page.route('**/api/integrations/linear/connect',route=>{connects++;return route.fulfill({json:{redirectUrl:'https://linear.example/authorize'}});});
  await context.route('https://linear.example/authorize',route=>route.fulfill({contentType:'text/plain',body:'Linear authorization fixture'}));
  const popupPromise=page.waitForEvent('popup');
  await page.getByRole('button',{name:'Connect Linear',exact:true}).click();
  const popup=await popupPromise;
  await expect(popup).toHaveURL('https://linear.example/authorize');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(connects).toBe(1);
  await popup.close();
  await page.getByRole('button',{name:'Connect Setup source',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Ask your administrator to configure this source.');
});

test('direct connect preserves busy state, closes a failed popup and allows retry',async({page})=>{
  const linear={...source(4),provider:'linear',name:'Linear'};
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[linear]}}));
  let release:()=>void=()=>{};
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/integrations/linear/connect',async route=>{await blocked;await route.fulfill({status:503,json:{error:'Sign-in is temporarily unavailable. Try again.'}});});
  await page.goto('/integrations-fixture');
  const button=page.getByRole('button',{name:'Connect Linear',exact:true});
  const popupPromise=page.waitForEvent('popup');
  await button.focus();
  await button.press('Enter');
  const popup=await popupPromise;
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('aria-busy','true');
  await expect(button).toHaveText('Connecting…');
  release();
  await expect(page.getByRole('alert')).toContainText('Sign-in is temporarily unavailable. Try again.');
  await expect.poll(()=>popup.isClosed()).toBe(true);
  await expect(button).toBeEnabled();
  await expect(button).toHaveText('Connect');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('cold status stays unknown and failed refreshes label retained measurements',async({page})=>{
  const cases:SourceCard[]=[
    {...source(1),name:'Cold connection',state:'connected',rows:undefined,synced:undefined,statusUpdatedAt:null,statusRefreshing:true},
    {...source(2),name:'Delayed refresh',statusUpdatedAt:'2026-11-05T12:00:00Z',lastSyncedAt:'2026-11-05T12:00:00Z',statusUnavailable:true},
  ];
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:cases}}));
  await page.goto('/integrations-fixture');
  const cold=page.getByRole('article',{name:'Cold connection'}),stale=page.getByRole('article',{name:'Delayed refresh'});
  await expect(cold).toContainText('Checking sync status…');
  await expect(cold.locator('.oc-integration-metrics')).toHaveCount(0);
  await expect(stale).toContainText('Status unavailable');
  await expect(stale.locator('.oc-integration-footer')).not.toContainText('Synced');
  await expect(stale.locator('.oc-integration-metrics')).toContainText('200');
  await expect(stale.locator('.oc-integration-metrics')).toBeVisible();
  await expect(stale.locator('.oc-integration-metrics')).toContainText('Last measured');
  await page.getByRole('button',{name:'Manage Delayed refresh'}).click();
  await expect(page.getByRole('dialog')).toContainText('Showing the last measurement.');
});

test('the first background measurement appears without waiting for the normal polling interval',async({page})=>{
  let reads=0;
  await page.route('**/api/console/sources',route=>{
    const item:SourceCard=++reads===1 ? {...source(1),state:'connected',rows:undefined,synced:undefined,statusUpdatedAt:null,statusRefreshing:true} : {...source(1),statusUpdatedAt:'2026-11-05T12:00:00Z',statusRefreshing:false};
    return route.fulfill({json:{items:[item]}});
  });
  await page.goto('/integrations-fixture');
  const card=page.getByRole('article',{name:'Example connector 01'});
  await expect(card).toContainText('Checking sync status…');
  await expect(card.locator('.oc-integration-metrics')).toContainText('100',{timeout:5000});
  await expect(card.locator('.oc-integration-metrics')).toBeVisible();
  expect(reads).toBe(2);
});

for(const width of [1440,320]) test(`integration cards keep long metrics inside equal tiles at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  const rows=Array.from({length:20},(_,i)=>({label:`Collection ${i+1}`,count:i,done:true}));
  const items=[{...source(1),name:'Long breakdown',rows},{...source(2),name:'Short breakdown',rows:[rows[0]!]}];
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items}}));
  await page.goto('/integrations-fixture');
  const imported=page.getByRole('article',{name:'Long breakdown'});
  const scroll=imported.getByRole('region',{name:'Long breakdown imported data',exact:true});
  await expect(scroll).toHaveAttribute('tabindex','0');
  await imported.scrollIntoViewIfNeeded();
  const height=await imported.evaluate(e=>e.getBoundingClientRect().height);
  const footerInset=await imported.evaluate(e=>e.querySelector('footer')!.getBoundingClientRect().top-e.getBoundingClientRect().top);
  await scroll.focus();
  await scroll.press('End');
  await expect.poll(()=>scroll.evaluate(e=>e.scrollTop)).toBeGreaterThan(0);
  await expect(scroll.getByRole('listitem').last()).toBeInViewport();
  expect(await imported.evaluate(e=>e.querySelector('footer')!.getBoundingClientRect().top-e.getBoundingClientRect().top)).toBe(footerInset);
  expect(await page.getByRole('article',{name:'Short breakdown'}).evaluate(e=>e.getBoundingClientRect().height)).toBe(height);
  await scroll.press('Tab');
  await expect(imported.getByRole('button',{name:'Manage Long breakdown'})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
