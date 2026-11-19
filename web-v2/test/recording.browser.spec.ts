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
  await expect(page.getByRole('heading',{name:'Session privacy',exact:true})).toHaveCount(0);
  const dialog = page.getByRole('dialog',{name:'Pause recording',exact:true});
  await pause.focus(); await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.matches(':modal'))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button',{name:'For 1 hour'})).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(pause).toBeFocused();
  await pause.click(); await dialog.getByRole('button',{name:'Close dialog'}).click();
  await expect(pause).toBeFocused();
  expect(modes).toEqual([]);
  for (const label of ['For 1 hour','Until I turn it back on']) {
    await pause.click();
    await dialog.getByRole('button',{name:label}).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Recording is paused',{exact:true})).toBeVisible();
    await page.reload();
    await expect(page.getByText(label === 'For 1 hour' ? /Resumes at/ : 'Until you resume recording.')).toBeVisible();
    await page.getByRole('button',{name:'Resume recording'}).click();
    await expect(pause).toBeEnabled();
  }
  expect(modes).toEqual(['hour','resume','indefinite','resume']);
});

test('recording and optional session privacy share one Settings tab', async ({page}) => {
  await page.route('**/api/console/bootstrap', route => route.fulfill({json:{
    cacheScope:'workspace-member', workspace:{name:'Example workspace',userName:'Alex',role:'member'},
    onboarding:{completed:true,next:'/'},mcpUrl:'/mcp',setupPrompt:'',canInvite:false,sessionPrivacy:true,
  }}));
  await page.route('**/api/library/recording/status', route => route.fulfill({json:{
    revision:'0',subject:'workspace-member',paused:false,until:null,
  }}));
  await page.route('**/api/library/privacy/status', route => route.fulfill({json:{
    revision:'0',subject:'workspace-member',enabled:true,rules:'',
  }}));
  await page.goto('/settings/privacy?full-app');
  await expect(page.getByRole('navigation',{name:'Settings'}).getByRole('link',{name:'Privacy',exact:true})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Pause recording',exact:true})).toBeEnabled();
  await expect(page.getByRole('checkbox',{name:'Automatically hide sensitive/personal sessions'})).toBeChecked();
});
