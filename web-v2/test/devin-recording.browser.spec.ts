import {expect,test} from '@playwright/test';
import type {DevinRecordingStatus} from '../../src/integrations/devin-recording.mjs';

for (const width of [1440,390]) test('Devin recording consent, search evidence and disconnect at '+width+'px',async ({page},info)=>{
  await page.setViewportSize({width,height:900});
  let current: DevinRecordingStatus | undefined;
  const initial: DevinRecordingStatus = {generation:'f60f086a-d19b-47ee-bba7-c4f87f3587ec',
    organization:'org-'+'1'.repeat(32),health:'connected',capture:'waiting',lastCheckedAt:null,connectedAt:new Date().toISOString()};
  const actions:unknown[] = [];
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[{provider:'devin',name:'Devin',auth:'api-key',scope:'team',
    state:current && current.health!=='disconnected'?'connected':'disconnected',devinRecording:current}]}}));
  await page.route('**/api/integrations/devin/recording',route=>{
    const input=route.request().postDataJSON();
    actions.push(input);
    current=input.action==='connect'?{...initial}:{...initial,health:'disconnected',capture:'stopped'};
    return route.fulfill({json:current});
  });
  await page.goto('/integrations-fixture');
  const card=page.getByRole('article',{name:'Devin'});
  await expect(card.locator('img')).toBeVisible();
  expect(await card.locator('img').evaluate((img:HTMLImageElement)=>img.complete && img.naturalWidth>0)).toBe(true);
  await card.getByRole('button',{name:'Connect Devin'}).click();
  const dialog=page.getByRole('dialog'), submit=dialog.getByRole('button',{name:'Connect and record'});
  await expect(dialog.getByRole('link',{name:'Service users in Devin'})).toHaveAttribute('href','https://app.devin.ai/settings/devin-api?tab=service-users');
  await expect(submit).toBeDisabled();
  await expect(dialog).toContainText('searchable by members of this OpenCrawl workspace');
  await expect(dialog).toContainText('output excerpts');
  await dialog.getByLabel('Organization service-user key').fill('cog_browser_fixture');
  await page.screenshot({path:info.outputPath('connect-'+width+'.png')});
  await submit.click();
  await expect(card).toContainText('Connected');
  await expect(card).toContainText('Waiting for the first indexed session.');
  await expect(card.getByRole('link')).toHaveCount(0);
  current={...initial,capture:'recording',latestSession:{harness:'devin',userId:'workload_devin_test',sessionId:'devin-test'}};
  await page.reload();
  await expect(card.getByRole('link',{name:'View indexed session'})).toHaveAttribute('href','/sessions?user=workload_devin_test&harness=devin&id=devin-test');
  await page.screenshot({path:info.outputPath('recording-'+width+'.png')});
  await card.getByRole('button',{name:'Manage Devin'}).click();
  await expect(dialog).toContainText('Previously indexed sessions stay');
  await dialog.getByRole('button',{name:'Disconnect',exact:true}).click();
  await expect(card.getByRole('button',{name:'Connect Devin'})).toBeVisible();
  expect(actions).toEqual([{action:'connect',record:true,serviceKey:'cog_browser_fixture'},{action:'disconnect',generation:initial.generation}]);
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain('cog_browser_fixture');
});
