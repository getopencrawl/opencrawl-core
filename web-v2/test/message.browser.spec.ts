import {expect, test} from '@playwright/test';

for (const width of [1280, 768, 390]) test(`signed-out message is centered at ${width}px`, async ({page}) => {
  await page.setViewportSize({width, height:900});
  await page.goto('/signed-out');
  const heading = page.getByRole('heading', {name:'You’re signed out'});
  await expect(heading).toBeVisible();
  const main = await page.locator('#main').boundingBox();
  const message = await page.locator('.oc-message-page').boundingBox();
  expect(main).not.toBeNull();
  expect(message).not.toBeNull();
  expect(Math.abs(message!.x + message!.width / 2 - width / 2)).toBeLessThan(1);
  expect(Math.abs(message!.y + message!.height / 2 - (main!.y + main!.height / 2))).toBeLessThan(1);
  expect(message!.y).toBeGreaterThan(200);
  await expect(heading).toHaveCSS('text-align', 'center');
  await expect(page.getByRole('link', {name:'Sign in', exact:true})).toHaveAttribute('href', '/auth/login');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
