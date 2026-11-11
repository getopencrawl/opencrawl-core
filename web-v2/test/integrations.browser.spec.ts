import {test, expect} from '@playwright/test';
import type {SourceCard} from '../src/application/api.ts';

const source = (index:number):SourceCard => ({provider:`example-${index}`,name:`Example connector ${String(index).padStart(2,'0')}`,auth:'oauth',scope:'team',state:index%4===0?'disconnected':'synced',description:'Shared workspace content.',account:index%4===0?null:'Example workspace',synced:index*100,rows:index%4===0?undefined:[{label:'Pages',count:index*100,done:true},{label:'Comments',count:index*150,done:true},{label:'Files',count:0,done:true}],primaryMetric:'Pages'});
const sources = Array.from({length:24},(_,i)=>source(24-i));
test.beforeEach(async({page,request})=>{
  await request.post('/__test/reset',{data:{}});
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:sources}}));
});
for(const width of [1440,390]) test(`uniform cards disclose complete stats and support search at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.goto('/integrations-fixture');
  const cards=page.getByRole('article');
  await expect(cards).toHaveCount(24);
  expect(await cards.evaluateAll(es=>es.map(e=>e.getAttribute('aria-label')))).toEqual([...sources].reverse().map(s=>s.name));
  expect(await cards.evaluateAll(es=>[...new Set(es.map(e=>e.getBoundingClientRect().height))])).toEqual([226]);
  const first=cards.first();
  await expect(first.locator('.oc-connector-headline')).toContainText('100');
  const more=first.locator('.oc-connector-more');
  await more.focus();
  await more.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded','true');
  await expect(first.locator('.oc-source-counts')).toBeVisible();
  await expect(first.locator('.oc-source-counts dd')).toHaveText(['100','150','0']);
  expect(await cards.nth(1).evaluate(e=>e.getBoundingClientRect().height)).toBe(226);
  await more.press('Space');
  await expect(more).toHaveAttribute('aria-expanded','false');
  await expect(more).toBeFocused();
  await page.getByRole('searchbox',{name:'Search integrations'}).fill('connector 19');
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveAttribute('aria-label','Example connector 19');
  await page.getByRole('searchbox').fill('');
  await page.getByRole('tab',{name:'Available 6'}).click();
  await expect(cards).toHaveCount(6);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('.oc-connector-dot').evaluateAll(es=>es.every(e=>getComputedStyle(e).width==='8px'&&getComputedStyle(e).boxShadow==='none'))).toBe(true);
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
  await page.getByRole('button',{name:'Details Expired'}).click();
  await expect(page.getByRole('button',{name:/Restart sign-in|Retry|Disconnect/})).toHaveCount(0);
});

test('cards keep account context in Manage and use primary Connect for both connection paths',async({page})=>{
  const connected={...source(1),name:'Connected source',account:'Example account',connectedBy:'admin@example.com'};
  const direct={...source(4),name:'Direct source'};
  const setup:SourceCard={...source(8),name:'Setup source',state:'setup-required',setup:{title:'Set up source',body:'Ask your administrator to configure this source.'}};
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[connected,direct,setup]}}));
  await page.goto('/integrations-fixture');
  const card=page.getByRole('article',{name:'Connected source',exact:true});
  await expect(card).not.toContainText('Example account');
  await expect(page.locator('.oc-connector-heading p')).toHaveCount(0);
  await card.getByRole('button',{name:'Manage Connected source'}).click();
  await expect(page.getByRole('dialog')).toContainText('Example account');
  await expect(page.getByRole('dialog')).toContainText('Connected by admin@example.com');
  await page.keyboard.press('Escape');
  for(const name of ['Direct source','Setup source']) await expect(page.getByRole('button',{name:`Connect ${name}`,exact:true})).toHaveClass(/\bprimary\b/);
  await page.getByRole('button',{name:'Connect Direct source',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Connect Direct source'})).toContainText('Workspace connection');
  await expect(page.getByRole('button',{name:'Continue to Direct source'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Connect Setup source',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('Ask your administrator to configure this source.');
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
  await expect(cold.locator('.oc-connector-headline')).toHaveCount(0);
  await expect(stale).toContainText('Status unavailable');
  await expect(stale.locator('.oc-connector-footer')).not.toContainText('Synced');
  await expect(stale.locator('.oc-connector-headline')).toContainText('200');
  await stale.getByRole('button',{name:'Show 2 more stats for Delayed refresh'}).click();
  await expect(stale.locator('.oc-source-counts')).toContainText('Last measured');
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
  await expect(card.locator('.oc-connector-headline')).toContainText('100',{timeout:5000});
  expect(reads).toBe(2);
});
