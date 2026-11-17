import {test,expect} from '@playwright/test';
test('Replicas previews scope before importing, resumes after an error, and never persists the key in browser storage',async({page})=>{
  const actions:string[]=[];
  let fail=true;
  const history={id:'f60f086a-d19b-47ee-bba7-c4f87f3587ec',organization:{id:'ab85158a-a7e9-49fa-902c-701f2bcc9321',name:'Getopencrawl'},phase:'preview',total:2,processed:0,imported:0,skipped:0,messages:0,updatedAt:'2026-11-17T00:00:00Z',sample:[{title:'Archived conversation',workspace:'Sleeping workspace',provider:'claude'}]};
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[{provider:'replicas',name:'Replicas',auth:'api-key',scope:'team',state:'disconnected'}]}}));
  await page.route('**/api/integrations/replicas/history',route=>{
    const input=route.request().postDataJSON() as {action:string;apiKey?:string};actions.push(input.action);
    if(input.action==='preview'){expect(input.apiKey).toBe('test-org-key');return route.fulfill({json:history});}
    if(input.action==='start'){history.phase='importing';return route.fulfill({json:history});}
    if(fail){fail=false;return route.fulfill({status:503,json:{error:{message:'Import paused. Resume to retry.'}}});}
    return route.fulfill({json:{...history,phase:'complete',processed:2,imported:2,messages:12}});
  });
  await page.goto('/integrations-fixture');await page.getByRole('button',{name:'Import history Replicas'}).click();
  await page.getByLabel('Replicas organization API key').fill('test-org-key');await page.getByRole('button',{name:'Preview history'}).click();
  await expect(page.getByText('Archived conversation — Sleeping workspace (claude)')).toBeVisible();expect(actions).toEqual(['preview']);
  await expect(page.getByText(/Previously captured live sessions may overlap/)).toBeVisible();
  await page.getByRole('button',{name:'Import into this workspace'}).click();
  await expect(page.getByRole('button',{name:'Resume import'})).toBeVisible();expect(actions).toEqual(['preview','start','step']);
  await page.getByRole('button',{name:'Resume import'}).click();await expect(page.getByText(/History import finished/)).toBeVisible();
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain('test-org-key');
});
