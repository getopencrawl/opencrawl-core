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
    {...source(1),name:'Expired',state:'error',recoveryAction:'connect',message:'Authorization expired.'},
    {...source(2),name:'Sync failed',state:'error',recoveryAction:'sync',message:'Sync failed.'},
    {...source(3),name:'Removal failed',state:'error',recoveryAction:'disconnect',message:'Removal did not finish.'},
  ];
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:cases}}));
  await page.goto('/integrations-fixture');
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
