import {test,expect} from '@playwright/test';

for(const width of [1280,390])test(`members read the board and search through the full application at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{cacheScope:'member-access',workspace:{name:'Workspace',userName:'Member',email:'member@example.test',role:'member'},mcpUrl:'https://app.example/mcp',setupPrompt:'Setup',canInvite:false,onboarding:{completed:true,next:'/'}}}));
  await page.route('**/api/console/board?*',route=>route.fulfill({json:{messages:[{id:1,timestamp:1800000000000,agent:'fixture',name:'codex:teammate',topic:'engineering',text:'Member-visible board message'}],next:null,topicSummaries:[{topic:'engineering',posts:1,latest:{id:1,timestamp:1800000000000,name:'codex:teammate'}}]}}));
  let query='';
  await page.route('**/api/debug/search',route=>{query=String(route.request().postDataJSON().query);return route.fulfill({json:{sessions:[],connectors:{state:'not_configured',responses:[]},memories:{state:'ready',hits:{total:{value:0},hits:[]}}}});});
  const boardQuery = '?full-app&view=board&channel=engineering&message=1#post';
  await page.goto('/diagnostics' + boardQuery);
  await expect(page).toHaveURL('/messages' + boardQuery);
  await expect(page.getByText('Member-visible board message')).toBeVisible();
  if(width<800)await page.getByRole('button',{name:'Browse channels'}).click();
  await expect(page.getByRole('navigation',{name:'Message board channels'}).getByRole('link',{name:'engineering',exact:true})).toBeVisible();
  await page.goto('/search?full-app');
  await page.getByRole('searchbox',{name:'Search query'}).fill('test member search');
  await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect.poll(()=>query).toBe('test member search');
  await expect(page.getByText(/Workspace admins|Ask an admin/)).toHaveCount(0);
  await page.goto('/onboarding/invite?full-app');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading',{name:'Invite your teammates'})).toHaveCount(0);
});

for(const width of [1280,390])test(`members never load Integrations, including after role loss at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  let role='member',reads=0;
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{cacheScope:role,workspace:{name:'Workspace',userName:'Member',role},mcpUrl:'https://app.example/mcp',setupPrompt:'Setup',canInvite:role==='admin',onboarding:{completed:true,next:'/'}}}));
  await page.route('**/api/console/sources',route=>{reads++;return route.fulfill({json:{items:[]}});});
  for(const path of ['/sources','/integrations','/data','/onboarding/sources']){
    await page.goto(path+'?full-app');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading',{name:'Integrations',exact:true})).toHaveCount(0);
  }
  expect(reads).toBe(0);
  role='admin';await page.goto('/sources?full-app&role=admin');
  await expect(page.getByText('No integrations available')).toBeVisible();
  expect(reads).toBe(1);
  role='member';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('No integrations available')).toHaveCount(0);
  const integrations = page.locator('#workspace-navigation a[href="/sources"]');
  await expect(integrations).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('opencrawl:access-denied', {detail:'Workspace access changed'})));
  await expect(page.getByText('Workspace access changed', {exact:true})).toBeVisible();
  await expect(integrations).toHaveCount(0);
  expect(reads).toBe(1);
});

test('members finish agent onboarding without fetching or showing admin steps',async({page})=>{
  let completed=false,finishes=0,restrictedReads=0;
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{cacheScope:'member-onboarding',workspace:{name:'Workspace',role:'member'},mcpUrl:'https://app.example/mcp',setupPrompt:'Setup',canInvite:false,onboarding:{completed,next:completed?'/':'/onboarding'}}}));
  await page.route('**/api/onboarding/finish',route=>{completed=true;finishes++;return route.fulfill({json:{workspaceUrl:'/'}});});
  await page.route(/\/api\/onboarding\/(sources|invites)$/,route=>{restrictedReads++;return route.fulfill({json:{items:[]}});});
  await page.goto('/onboarding/sources?full-app');
  await expect(page).toHaveURL(/\/$/);
  expect(finishes).toBe(1);expect(restrictedReads).toBe(0);
  await expect(page.getByRole('heading',{name:/Connect your sources|Invite your teammates/})).toHaveCount(0);
});

test('members with incomplete agent setup return to it when server completion refuses',async({page})=>{
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{cacheScope:'member-incomplete',workspace:{name:'Workspace',role:'member'},mcpUrl:'https://app.example/mcp',setupPrompt:'Setup',canInvite:false,onboarding:{completed:false,next:'/onboarding'}}}));
  await page.route('**/api/onboarding/finish',route=>route.fulfill({status:409,json:{error:'Complete agent setup first.'}}));
  await page.route('**/api/onboarding',route=>route.fulfill({json:{}}));
  await page.goto('/onboarding/invite?full-app');
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading',{name:'Connect your primary coding agent'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Invite your teammates'})).toHaveCount(0);
});
