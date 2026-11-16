import {test,expect,type Page} from '@playwright/test';
import type {SetupStatus} from '../../src/application/types.mjs';

const empty:SetupStatus={schemaVersion:1,scope:{tenantId:'fixture',userId:'alex'},firstWin:null,installations:[]};
const now='2026-11-14T20:00:00.000Z';
const partial:SetupStatus={...empty,firstWin:{installationId:'mac',client:'codex',verifiedAt:now},installations:[{
  installationId:'mac',machine:{id:'machine-mac',label:'Alex’s Mac'},updatedAt:now,clients:[
    {client:'codex',installed:true,forward:true,history:'import',historyProgress:{state:'running',completed:20,total:80},hookTrust:'trusted',mcp:{state:'authenticated',observedAt:now},proof:{state:'verified',verifiedAt:now,sessionId:'new-session'},humanTasks:[]},
    {client:'claude-code',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending',mcp:{state:'pending'},proof:{state:'pending'},humanTasks:[{id:'trust-claude',kind:'hook_trust',client:'claude-code',title:'Trust Claude Code hooks',instruction:'Review the native hook trust prompt.'}]},
    {client:'cursor',installed:false,forward:false,history:'import',historyProgress:{state:'complete',completed:12,total:12},hookTrust:'unknown',mcp:{state:'pending'},proof:{state:'not_selected'},humanTasks:[]},
    {client:'antigravity',installed:true,forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},hookTrust:'pending',captureObservedAt:now,mcp:{state:'observed',observedAt:now},proof:{state:'waiting_index'},humanTasks:[]},
  ],
}]};
async function start(page:Page,setup:SetupStatus=empty){await page.request.post('/__test/reset',{data:{setup}});await page.goto('/setup?full-app');await expect(page.getByRole('heading',{level:1,name:'Setup'})).toBeVisible();}

test('incomplete setup never blocks the application or SPA history',async({page})=>{
  await start(page);
  const navigation=page.getByRole('navigation',{name:'Workspace navigation'});
  await expect(navigation.getByRole('link').first()).toHaveText('Setup');
  await expect(page.getByText('No installations yet')).toBeVisible();
  await page.evaluate(()=>{document.body.dataset.setupNavigation='preserved';});
  await navigation.getByRole('link',{name:'Sessions',exact:true}).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByRole('heading',{level:1,name:'Sessions'})).toBeVisible();
  await navigation.getByRole('link',{name:'Integrations',exact:true}).click();
  await expect(page.getByRole('heading',{level:1,name:'Integrations'})).toBeVisible();
  await page.goBack();await expect(page).toHaveURL(/\/sessions$/);
  await page.goForward();await expect(page).toHaveURL(/\/sources$/);
  expect(await page.evaluate(()=>document.body.dataset.setupNavigation)).toBe('preserved');
});

test('Setup keeps each client and history selection independent after the first win',async({page})=>{
  await start(page,partial);
  await expect(page.getByText('Your first session is searchable')).toBeVisible();
  const codex=page.locator('.oc-status-row').filter({has:page.getByRole('heading',{name:'Codex',exact:true})});
  await expect(codex.getByText('Verified',{exact:true})).toBeVisible();
  await expect(codex.getByText('Future recording on. History: Importing, 20 of 80 processed.',{exact:true})).toBeVisible();
  const claude=page.locator('.oc-status-row').filter({has:page.getByRole('heading',{name:'Claude Code',exact:true})});
  await expect(claude.getByText('Continue in your agent',{exact:true})).toBeVisible();
  await claude.getByText('Connection and import status').click();
  await expect(claude.getByText('Trust required',{exact:true})).toBeVisible();
  await expect(claude.getByText('Sign-in required',{exact:true})).toBeVisible();
  const cursor=page.locator('.oc-status-row').filter({has:page.getByRole('heading',{name:'Cursor',exact:true})});
  await expect(cursor.getByText('History only',{exact:true})).toBeVisible();
  await cursor.getByText('Connection and import status').click();
  await expect(cursor.getByText('Installation not reported',{exact:true})).toBeVisible();
  await expect(cursor.getByText('Sign-in required',{exact:true})).toHaveCount(0);
  const antigravity=page.locator('.oc-status-row').filter({has:page.getByRole('heading',{name:'Antigravity',exact:true})});
  await antigravity.getByText('Connection and import status').click();
  await expect(antigravity.getByText('Connection observed, client verification pending',{exact:true})).toBeVisible();
  await expect(antigravity.getByText('Capture observed',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Agent handoff',{exact:true})).toHaveValue(/opencrawl setup status.*--json/);
  await expect(page.getByRole('button',{name:/Test MCP|Finish setup|Install on Replicas/})).toHaveCount(0);
});

test('failed status reads retain the page and retry without blocking navigation',async({page})=>{
  await page.request.post('/__test/reset',{data:{setupError:true}});await page.goto('/setup?full-app');
  await expect(page.getByRole('heading',{level:1,name:'Setup'})).toBeVisible();
  await expect(page.getByText('Setup status is temporarily unavailable.')).toBeVisible();
  await page.request.post('/__test/state',{data:{setupError:false,setup:empty}});
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText('No installations yet')).toBeVisible();
});

for(const viewport of [{name:'desktop',width:1280,height:900},{name:'mobile',width:390,height:844}])test(`prepared plugin files show the native activation action (${viewport.name})`,async({page},testInfo)=>{
  await page.setViewportSize({width:viewport.width,height:viewport.height});
  const installation=partial.installations[0]!;
  const cursor:SetupStatus['installations'][number]['clients'][number]={...installation.clients[2]!,pluginState:'prepared',forward:true,history:'skip',historyProgress:{state:'not_started',completed:0},proof:{state:'pending'}};
  await start(page,{...empty,installations:[{...installation,clients:[cursor]}]});
  const row=page.locator('.oc-status-row');
  await expect(row.getByText('Activation pending',{exact:true})).toBeVisible();
  await row.getByText('Connection and import status').click();
  await expect(row.getByText('Files ready, activation not reported',{exact:true})).toBeVisible();
  await expect(row.getByText('Open or reload Cursor, then continue setup in that client.',{exact:false})).toBeVisible();
  await expect(row.getByText('Not installed',{exact:true})).toHaveCount(0);
  await expect(row.getByText('Installed',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Continue with your agent',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)).toBe(false);
  await page.screenshot({path:testInfo.outputPath('prepared-plugin.png'),fullPage:true});
});

test('native MCP verification stays visible while CLI activation reporting is pending',async({page})=>{
  const installation=partial.installations[0]!;
  const codex={...installation.clients[0]!,installed:false,history:'skip' as const,captureObservedAt:now};
  await start(page,{...partial,installations:[{...installation,clients:[codex]}]});
  const row=page.locator('.oc-status-row');
  await expect(row.getByText('Session searchable',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with your agent',exact:true})).toHaveCount(0);
  await row.getByText('Connection and import status').click();
  await expect(row.getByText('Activation not reported',{exact:true})).toBeVisible();
  await expect(row.getByText('Connected',{exact:true})).toBeVisible();
  await expect(row.getByText('Installed',{exact:true})).toHaveCount(0);
  await expect(row.getByText('Not selected',{exact:true})).toBeVisible();
  for(const state of ['pending','observed'] as const){
    await start(page,{...partial,installations:[{...installation,clients:[{...codex,mcp:{state}}]}]});
    await expect(page.getByRole('button',{name:'Continue with your agent',exact:true})).toBeVisible();
    await expect(page.getByText('MCP verification pending',{exact:true})).toBeVisible();
  }
});

test('legacy setup URLs open permanent Setup and preserve workspace navigation',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  for(const path of ['/onboarding','/agent-setup']){
    await page.goto(path+'?full-app#continue');await expect(page).toHaveURL(/\/setup\?full-app#continue$/);
    await expect(page.getByRole('heading',{level:1,name:'Setup'})).toBeVisible();
    await expect(page.getByRole('navigation',{name:'Workspace navigation'})).toBeVisible();
  }
});

test('Settings and legacy Team links keep their own destination while Setup stays first',async({page})=>{
  await page.request.post('/__test/reset',{data:{}});
  for(const path of ['/settings','/team','/onboarding/invite']){
    await page.goto(path+'?full-app#members');await expect(page).toHaveURL(/\/settings\/team\?full-app#members$/);
    await expect(page.getByRole('heading',{level:1,name:'Settings'})).toBeVisible();
    const navigation=page.getByRole('navigation',{name:'Workspace navigation'});
    await expect(navigation.getByRole('link').first()).toHaveText('Setup');
    await expect(navigation.getByRole('link',{name:'Team',exact:true})).toHaveCount(0);
  }
});

test('self-host Setup commands keep the selected server and contain no cloud fallback',async({page})=>{
  await page.route('**/api/console/bootstrap',async route=>{const response=await route.fetch();const body:unknown=await response.json();if(typeof body!=='object'||body===null)throw Error('Invalid fixture');await route.fulfill({json:{...body,mcpUrl:'https://knowledge.example.test/mcp'}});});
  await start(page,partial);
  await expect(page.getByLabel('Setup command',{exact:true})).toHaveValue("opencrawl setup --api 'https://knowledge.example.test'");
  await expect(page.getByLabel('Agent handoff',{exact:true})).toHaveValue(/verify-installation --api 'https:\/\/knowledge.example.test' --client CLIENT --json/);
  await expect(page.getByLabel('Agent handoff',{exact:true})).toHaveValue(/MCP connection at https:\/\/knowledge.example.test\/mcp/);
});

test('mobile Setup stays within the viewport and navigation is keyboard accessible',async({page})=>{
  await page.setViewportSize({width:390,height:844});await start(page,partial);
  await expect(page.getByLabel('Install and set up',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Install and set up',{exact:true})).toHaveValue(/opencrawl_installer=\$\(curl/);
  await page.getByRole('button',{name:'Open workspace navigation'}).click();
  await expect(page.getByRole('navigation',{name:'Workspace navigation'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Setup',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Open workspace navigation'})).toBeFocused();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
  expect(overflow).toBe(false);
});

test('agent handoff copies one stable instruction and supports manual copy when clipboard is unavailable',async({page})=>{
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Clipboard unavailable');}}});});
  await start(page,partial);
  await page.getByRole('button',{name:'Continue with your agent',exact:true}).click();
  const handoff=page.getByLabel('Agent handoff',{exact:true});
  await expect(handoff).toBeVisible();await expect(handoff).toBeFocused();
  await expect(handoff).toHaveValue(/opencrawl setup status.*--json/);
  await page.request.post('/__test/state',{data:{setup:{...partial,firstWin:null}}});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(handoff).toBeFocused();
  await expect(page).toHaveURL(/\/setup\?full-app$/);
});

test('verified installations keep add-client setup available without asking to finish again',async({page})=>{
  const installation=partial.installations[0]!;
  const codex=installation.clients[0]!;
  const complete:SetupStatus={...partial,installations:[{...installation,clients:[{...codex,history:'skip',historyProgress:{state:'failed',completed:20,total:80}}]}]};
  await start(page,complete);
  await expect(page.getByRole('button',{name:'Continue with your agent',exact:true})).toHaveCount(0);
  await expect(page.getByText('Import needs attention',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Add or update an installation'})).toBeVisible();
  await expect(page.getByText('New setup is available for Claude Code, Codex, and Cursor on macOS. Choose plugins, future recording, and past sessions separately.',{exact:true})).toBeVisible();
  await expect(page.getByLabel('Setup command',{exact:true})).toHaveValue(/opencrawl setup/);
});

test('search and history-only clients stop prompting once MCP is observed and recording is off',async({page})=>{
  const installation=partial.installations[0]!;
  const searchOnly:SetupStatus={...empty,installations:[{...installation,clients:[
    {...installation.clients[0]!,forward:false,history:'skip',historyProgress:{state:'not_started',completed:0},mcp:{state:'observed',observedAt:now},proof:{state:'not_selected'},humanTasks:[]},
    {...installation.clients[1]!,forward:false,history:'import',historyProgress:{state:'complete',completed:12,total:12},mcp:{state:'observed',observedAt:now},proof:{state:'not_selected'},humanTasks:[]},
  ]}]};
  await start(page,searchOnly);
  await expect(page.getByRole('button',{name:'Continue with your agent',exact:true})).toHaveCount(0);
  await expect(page.getByText('Your first session is searchable',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('heading',{name:'Add or update an installation'})).toBeVisible();
  await expect(page.getByText('Future recording off',{exact:true})).toHaveCount(2);
  for(const row of await page.locator('.oc-status-row').all()){
    await row.getByText('Connection and import status').click();
    await expect(row.getByText('Connection observed, capture not selected',{exact:true})).toBeVisible();
    await expect(row.getByText('Connected',{exact:true})).toHaveCount(0);
    await expect(row.getByText('Verified',{exact:true})).toHaveCount(0);
  }
});

test('recording-off clients still offer the agent for pending sign-in or a failed selected import',async({page})=>{
  const installation=partial.installations[0]!;
  const client={...installation.clients[0]!,forward:false,proof:{state:'not_selected' as const},humanTasks:[]};
  for(const pending of [
    {...client,history:'skip' as const,mcp:{state:'pending' as const}},
    {...client,mcp:{state:'observed' as const,observedAt:now},historyProgress:{state:'failed' as const,completed:3,total:12}},
  ]){
    await start(page,{...empty,installations:[{...installation,clients:[pending]}]});
    await expect(page.getByRole('button',{name:'Continue with your agent',exact:true})).toBeVisible();
  }
});

test('preview bootstrap uses its pinned installer instead of released CLI distribution',async({page})=>{
  await page.route('**/api/console/bootstrap',async route=>{const response=await route.fetch();const body:unknown=await response.json();if(typeof body!=='object'||body===null)throw Error('Invalid fixture');await route.fulfill({json:{...body,mcpUrl:'https://preview.example/mcp',setupStartCommand:'sh /private/preview/install-012345.sh && \"/private/preview/opencrawl\" setup',setupCliCommand:'\"/private/preview/opencrawl\"'}});});
  await start(page);
  const command=page.getByLabel('Install and set up',{exact:true});
  await expect(command).toHaveValue('sh /private/preview/install-012345.sh && "/private/preview/opencrawl" setup');
  await page.getByText('CLI already installed', {exact:true}).click();
  await expect(page.getByLabel('Setup command',{exact:true})).toHaveValue('"/private/preview/opencrawl" setup --api \'https://preview.example\'');
  expect(await command.inputValue()).not.toMatch(/raw\.githubusercontent\.com|\/main\/|latest/);
  await start(page,partial);
  await expect(page.getByLabel('Agent handoff',{exact:true})).toHaveValue(/\"\/private\/preview\/opencrawl\" setup status.*--client CLIENT --json/);
});
