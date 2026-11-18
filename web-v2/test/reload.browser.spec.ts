import {test, expect} from '@playwright/test';
import type {Bootstrap, TeamReport} from '../src/application/api.ts';

test('an admitted reload shows its roster before either background read finishes and drops it on denial', async ({page}) => {
  const bootstrap: Bootstrap = {cacheScope:'session-a-admin',workspace:{name:'Workspace A',userName:'Alex',email:'alex@example.test',role:'admin'},onboarding:{completed:true,next:'/'},mcpUrl:'/mcp',setupPrompt:'',canInvite:true};
  const team: TeamReport = {organization:{id:'a',name:'Workspace A'},viewerUserId:'alex',role:'admin',members:[{id:'alex',name:'Cached teammate',email:'alex@example.test',role:'admin'}]};
  const payload = JSON.stringify({bootstrap,reports:{'console.team':team}});
  await page.route('**/settings/team?full-app',async route => {
    const response = await route.fetch();
    await route.fulfill({response,body:(await response.text()).replace('</head>', '<script type="application/json" id="opencrawl-reload">'+payload+'</script></head>')});
  });
  let release = () => {};
  const held = new Promise<void>(resolve => {release=resolve;});
  let bootReads=0, teamReads=0;
  await page.route('**/api/console/bootstrap', async route => {bootReads++;await held;await route.fulfill({json:bootstrap});});
  await page.route('**/api/console/team', async route => {teamReads++;await held;await route.fulfill({status:403,json:{error:'Access ended'}});});
  try {
    await page.goto('/settings/team?full-app');
    await expect(page.getByText('Cached teammate',{exact:true})).toBeVisible();
    await expect.poll(() => [bootReads,teamReads]).toEqual([1,1]);
    await expect(page.locator('.oc-content .oc-loading')).toHaveCount(0);
  } finally {release();}
  await expect(page.getByRole('alert')).toContainText('Access ended');
  await expect(page.getByText('Cached teammate',{exact:true})).toHaveCount(0);
});
