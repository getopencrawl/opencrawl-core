import {test, expect} from '@playwright/test';

test('daily stacks preserve proportions, zero days and untracked days with a keyboard-readable legend', async ({page}) => {
  await page.goto('/stacked-usage-fixture');
  const chart = page.getByRole('img', {name: 'Items per day'}), selection = page.getByRole('combobox', {name: 'Day to inspect'});
  const legend = page.getByRole('list', {name: 'Series breakdown'}), status = page.getByRole('status');
  await expect(page.getByText('Date (UTC)', {exact:true})).toBeVisible();
  await expect(page.getByText('Items', {exact:true})).toBeVisible();
  await chart.focus(); await page.keyboard.press('Home');
  await expect(status).toHaveText('2026-11-17: 10 items. Sessions 2 items. Documents 3 items. Memories 5 items');
  const bounds = await chart.locator('.is-active .report-stack-segment').evaluateAll(nodes => nodes.map(node =>
    ({height:Number(node.getAttribute('height')), y:Number(node.getAttribute('y')), color:getComputedStyle(node).fill})));
  expect(bounds).toHaveLength(3);
  expect(bounds[0]!.height / bounds[2]!.height).toBeCloseTo(2/5);
  expect(bounds[1]!.y + bounds[1]!.height).toBeCloseTo(bounds[0]!.y);
  expect(bounds[2]!.y + bounds[2]!.height).toBeCloseTo(bounds[1]!.y);
  expect(new Set(bounds.map(b => b.color)).size).toBe(3);
  expect(await legend.locator('.report-series-key').evaluateAll(nodes => nodes.map(n=>getComputedStyle(n).backgroundColor))).toEqual(bounds.map(b=>b.color));
  await page.keyboard.press('ArrowRight');
  await expect(selection).toHaveValue('1'); await expect(status).toContainText('2026-11-18: 0 items');
  await expect(chart.locator('.is-active .report-stack-segment')).toHaveCount(0);
  await expect(legend.getByText('0 items', {exact:true})).toHaveCount(3);
  await selection.selectOption('2'); await expect(status).toHaveText('2026-11-19: not tracked');
  await expect(legend.getByText('Unavailable')).toHaveCount(3);
});

test.describe('touch chart', () => {
  test.use({hasTouch:true,viewport:{width:320,height:700}});
  test('a tap selects the day and its breakdown fits the viewport', async ({page}) => {
    await page.goto('/stacked-usage-fixture');
    const chart = page.getByRole('img', {name:'Items per day'});
    await chart.locator('.report-bar-hit').first().tap();
    await expect(page.getByRole('combobox', {name:'Day to inspect'})).toHaveValue('0');
    await expect(page.getByRole('status')).toContainText('Documents 3 items');
    await expect(page.getByText('5 items', {exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
