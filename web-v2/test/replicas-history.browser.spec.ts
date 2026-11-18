import {test,expect} from '@playwright/test';
for(const width of [1440,390])test(`Replicas connects with one submission and runs after leaving the page at ${width}px`,async({page},info)=>{
  await page.clock.install();
  await page.setViewportSize({width,height:width===390?844:900});
  const shot=(name:string)=>page.screenshot({path:info.outputPath(`replicas-${width}-${name}.png`),fullPage:true});
  const calls:string[]=[];
  let state='disconnected',release=()=>{};
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const history={id:'f60f086a-d19b-47ee-bba7-c4f87f3587ec',organization:{id:'ab85158a-a7e9-49fa-902c-701f2bcc9321',name:'Getopencrawl'},phase:'importing',total:2,processed:0,imported:0,events:0,turns:0,pages:0,updatedAt:'2026-11-17T00:00:00Z'};
  await page.route('**/api/console/sources',route=>route.fulfill({json:{items:[
    {provider:'github',name:'GitHub',auth:'oauth',scope:'team',state:'disconnected'},
    {provider:'replicas',name:'Replicas',auth:'api-key',scope:'team',state,...state==='disconnected'?{}:{
      history,rows:[{label:'Sessions',count:history.imported},{label:'Events',count:history.events}],synced:history.processed,total:history.total,units:['conversation record','conversation records'],message:state==='error'?'Reconnect to resume from the last saved page.':undefined}},
    {provider:'slack',name:'Slack',auth:'oauth',scope:'team',state:'disconnected'},
  ]}}));
  await page.route('**/api/integrations/replicas/history',async route=>{
    const {action,apiKey}=route.request().postDataJSON();calls.push(action);
    if(apiKey==='invalid')return route.fulfill({status:400,json:{error:{message:'Replicas denied access. Use an organization API key.'}}});
    expect(apiKey).toBe('test-org-key');await hold;state='syncing';return route.fulfill({json:history});
  });
  await page.goto('/integrations-fixture');
  const open=page.getByRole('button',{name:'Connect Replicas'});await expect(open).toBeVisible();
  expect(await page.locator('img[src$="/replicas.svg"]').evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true);
  await shot('available');await open.click();
  const dialog=page.getByRole('dialog'),key=dialog.getByLabel('Organization API key'),connect=dialog.getByRole('button',{name:'Connect',exact:true});
  await expect(connect).toBeDisabled();await shot('dialog');
  await key.fill('invalid');await connect.click();await expect(dialog.getByText(/Replicas denied access/)).toBeVisible();await shot('invalid');
  await key.fill('test-org-key');await connect.click();await expect(dialog.getByText('Connecting…')).toBeVisible();await shot('checking');release();
  await expect(dialog).toHaveCount(0);await expect(page.getByText(/Replicas connected/)).toBeVisible();await expect(open).toHaveCount(0);
  const progress=page.getByRole('progressbar',{name:'Replicas import progress'});
  await expect(progress).toHaveAttribute('value','0');await expect(progress).toHaveAttribute('max','2');await shot('success');
  Object.assign(history,{processed:1,imported:1,events:8});await page.clock.runFor(30_001);
  await expect(progress).toHaveAttribute('value','1');await expect(page.getByText('1 of 2 conversation records imported')).toBeVisible();await shot('progress');
  await page.goto('about:blank');state='synced';Object.assign(history,{phase:'complete',processed:2,imported:2,events:12});
  await page.goto('/integrations-fixture');await expect(page.getByText('Synced',{exact:true}).first()).toBeVisible();await expect(progress).toHaveCount(0);await shot('complete');
  Object.assign(history,{processed:0,imported:0,events:0,total:0});await page.reload();
  await expect(page.getByText('Synced',{exact:true}).first()).toBeVisible();await expect(page.getByLabel('Replicas imported data').getByText('0',{exact:true})).toHaveCount(2);await shot('empty');
  state='error';history.phase='failed';
  await page.reload();await expect(open).toBeVisible();await expect(page.getByText('Needs attention',{exact:true}).first()).toBeVisible();await expect(page.getByText('Reconnect to resume from the last saved page.')).toBeVisible();await shot('background-error');
  expect(calls).toEqual(['connect','connect']);expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain('test-org-key');
});

test('Replicas transcript exposes the entire original record beyond the display preview',async({page})=>{
  const raw={events:[{type:'future-tool',payload:{output:'retained output '.repeat(3000)+'original_tail_receipt'}}],unknownMetadata:{kept:true}};
  const session={userId:'workload_replicas_test',harness:'replicas',sessionId:'replicas-chat:test',title:'Complete Replicas history',private:false,mine:false,origin:'cloud',host:null,hosts:[],hostsTruncated:false,firstActivityAt:null,lastActivityAt:null,events:1};
  await page.route('**/api/library/**',route=>route.fulfill({json:{session,events:[{eventId:'raw-page',kind:'replicas_history_page',timestamp:null,entries:[{type:'note',label:'Original history page',text:'Complete response preserved.',truncated:false}],raw}],total:1,next:null}}));
  await page.goto('/sessions?user=workload_replicas_test&harness=replicas&id=replicas-chat%3Atest');
  await page.locator('.oc-log-tools > summary').click();await page.locator('.oc-log-tool > summary').click();
  await page.getByText('Original Replicas record',{exact:true}).click();
  await expect(page.locator('pre').last()).toContainText('original_tail_receipt');
  await expect(page.locator('pre').last()).toContainText('unknownMetadata');
});
