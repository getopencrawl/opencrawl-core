import {expect, test} from '@playwright/test';

for (const width of [1280, 390]) {
  test(`auth forms keep the shared panel and fit a ${width}px viewport`, async ({page}) => {
    await page.setViewportSize({width, height: 844});
    for (const view of ['login', 'login-error', 'setup', 'join', 'device', 'consent']) {
      await page.goto(`/auth-fixture/${view}`);
      const panel = page.locator('main > .oc-auth-page');
      await expect(panel.getByRole('heading', {level: 1})).toBeVisible();
      await expect(panel).toHaveCSS('max-width', '480px');
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      expect(Math.abs(bounds!.x * 2 + bounds!.width - width)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

test('device approval submits the code shown in the terminal', async ({page}) => {
  await page.goto('/auth-fixture/device');
  const code = page.getByLabel('Connection code');
  await expect(code).toHaveValue('TEST-1234');
  await expect(code).toHaveAttribute('readonly', '');
  await page.route('**/device', route => route.fulfill({contentType: 'text/plain', body: 'Connected'}));
  const posted = page.waitForRequest(request => new URL(request.url()).pathname === '/device');
  await page.getByRole('button', {name: 'Connect CLI', exact: true}).click();
  const fields = new URLSearchParams((await posted).postData() || '');
  expect(fields.get('user_code')).toBe('TEST-1234');
  expect(fields.get('decision')).toBe('approve');
});

test('Imprint follows the system palette and keeps the action on screen', async ({page}) => {
  const markBounds = () => page.locator('.oc-imprint-art img').boundingBox();
  const darkMarks = new Map<number, Awaited<ReturnType<typeof markBounds>>>();
  for (const colorScheme of ['dark','light'] as const) {
    await page.emulateMedia({colorScheme});
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:800});
      await page.goto('/auth-fixture/imprint');
      await expect(page.getByRole('button',{name:'Continue'})).toBeInViewport();
      const art = page.locator('.oc-imprint-art');
      expect(await art.locator('img').evaluate(img=>(img as HTMLImageElement).currentSrc)).toContain('/assets/opencrawl-mark.svg');
      const grain = await art.evaluate(el => {
        const layer = getComputedStyle(el, '::before');
        return {image:layer.backgroundImage, size:layer.backgroundSize, opacity:Number(layer.opacity)};
      });
      expect(grain.image).toContain('/assets/imprint-paper.png');
      expect(grain.size).toBe('256px 256px');
      expect(grain.opacity).toBeGreaterThan(0);
      if (colorScheme === 'light') expect(grain.opacity).toBeLessThan(.35);
      else expect(grain.opacity).toBe(1);
      const mark = await markBounds();
      expect(mark?.width).toBeGreaterThan(0);
      if (colorScheme === 'dark') darkMarks.set(width, mark);
      else expect(mark).toEqual(darkMarks.get(width));
      const poster=await art.boundingBox(), pane=await page.getByRole('main').boundingBox();
      expect(width>700 ? poster!.x+poster!.width<=pane!.x : poster!.y+poster!.height<=pane!.y).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
});
