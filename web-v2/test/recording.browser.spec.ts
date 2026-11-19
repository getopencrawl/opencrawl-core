import {test, expect} from '@playwright/test';

test('members can pause and resume their recording under Settings / Privacy', async ({page}) => {
  await page.route('**/api/console/bootstrap', route => route.fulfill({json:{
    cacheScope:'workspace-member', workspace:{name:'Example workspace', userName:'Alex', role:'member'},
    onboarding:{completed:true,next:'/'}, mcpUrl:'/mcp', setupPrompt:'', canInvite:false,
  }}));
  let state: {revision:string; paused:boolean; until:number|null} = {revision:'0',paused:false,until:null};
  const modes: string[] = [];
  await page.route('**/api/library/sessions/list', route => route.fulfill({json:{sessions:[],limit:50}}));
  await page.route('**/api/library/recording/**', async route => {
    if (route.request().url().endsWith('/change')) {
      const input = route.request().postDataJSON();
      expect(input.revision).toBe(state.revision);
      expect(input.subject).toBe('workspace-member');
      modes.push(input.mode);
      state = {revision:String(modes.length),paused:input.mode!=='resume',until:input.mode==='hour'?Date.now()+3600000:null};
    }
    await route.fulfill({json:{...state,subject:'workspace-member'}});
  });
  const pause = page.getByRole('button',{name:'Pause recording',exact:true});
  await page.goto('/sessions?full-app');
  await expect(page.getByRole('heading',{name:'Sessions',exact:true})).toBeVisible();
  await expect(pause).toHaveCount(0);
  await page.goto('/settings/privacy?full-app');
  await expect(page.getByRole('navigation',{name:'Settings'}).getByRole('link',{name:'Privacy'})).toHaveAttribute('aria-current','page');
  await pause.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'For 1 hour'})).toBeFocused();
  await page.keyboard.press('Escape'); await expect(pause).toBeFocused();
  for (const label of ['For 1 hour','Until I turn it back on']) {
    await pause.click();
    await page.getByRole('group',{name:'Pause duration'}).getByRole('button',{name:label}).click();
    await expect(page.getByText('Recording is paused',{exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByText(label === 'For 1 hour' ? /Resumes at/ : 'Until you resume recording.')).toBeVisible();
    await page.getByRole('button',{name:'Resume recording'}).click();
    await expect(pause).toBeEnabled();
  }
  expect(modes).toEqual(['hour','resume','indefinite','resume']);
});
