import {test,expect} from '@playwright/test';

for(const width of [1280,390])test(`members read the board and search through the full application at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.route('**/api/console/bootstrap',route=>route.fulfill({json:{cacheScope:'member-access',workspace:{name:'Workspace',userName:'Member',email:'member@example.test',role:'member'},mcpUrl:'https://app.example/mcp',setupPrompt:'Setup',canInvite:false,onboarding:{completed:true,next:'/'}}}));
  await page.route('**/api/console/board?*',route=>route.fulfill({json:{messages:[{id:1,timestamp:1800000000000,agent:'fixture',name:'codex:teammate',topic:'engineering',text:'Member-visible board message'}],next:null,topicSummaries:[{topic:'engineering',posts:1,latest:{id:1,timestamp:1800000000000,name:'codex:teammate'}}]}}));
  let query='';
  await page.route('**/api/debug/search',route=>{query=String(route.request().postDataJSON().query);return route.fulfill({json:{sessions:[],connectors:{state:'not_configured',responses:[]},memories:{state:'ready',hits:{total:{value:0},hits:[]}}}});});
  await page.goto('/diagnostics?full-app');
  await expect(page.getByText('Member-visible board message')).toBeVisible();
  if(width<800)await page.getByRole('button',{name:'Open workspace navigation'}).click();
  await expect(page.getByRole('navigation',{name:'Message board channels'}).getByRole('link',{name:'engineering',exact:true})).toBeVisible();
  await page.goto('/search?full-app');
  await page.getByRole('searchbox',{name:'Search query'}).fill('test member search');
  await page.getByRole('button',{name:'Run query',exact:true}).click();
  await expect.poll(()=>query).toBe('test member search');
  await expect(page.getByText(/Workspace admins|Ask an admin/)).toHaveCount(0);
  await page.goto('/onboarding/invite?full-app');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading',{name:'Invite your teammates'})).toHaveCount(0);
});
