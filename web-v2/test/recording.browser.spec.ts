import {test,expect} from '@playwright/test';

test('personal recording offers both pauses and resumes from the sessions header',async({page,request})=>{
  await request.post('/__test/reset',{data:{}});
  let state:{revision:string;paused:boolean;until:number|null}={revision:'0',paused:false,until:null};
  const modes:string[]=[];
  await page.route('**/api/library/sessions/list',route=>route.fulfill({json:{sessions:[],limit:50}}));
  await page.route('**/api/library/recording/**',async route=>{
    if(route.request().url().endsWith('/change')){
      const input=route.request().postDataJSON();expect(input.revision).toBe(state.revision);expect(input.subject).toBe('workspace-member');modes.push(input.mode);
      state={revision:String(modes.length),paused:input.mode!=='resume',until:input.mode==='hour'?Date.now()+3600000:null};
    }
    await route.fulfill({json:{...state,subject:'workspace-member'}});
  });
  await page.goto('/sessions');
  for(const label of ['For 1 hour','Until I turn it back on']){
    await page.getByRole('button',{name:'Pause recording',exact:true}).click();
    await expect(page.getByText('Pauses every agent signed in as you in this workspace.',{exact:false})).toBeVisible();
    await page.getByRole('dialog',{name:'Pause recording'}).getByRole('button',{name:label}).click();
    await expect(page.getByRole('button',{name:'Resume recording'})).toBeVisible();
    await page.reload();
    await page.getByRole('button',{name:'Resume recording'}).click();
    await expect(page.getByRole('button',{name:'Pause recording',exact:true})).toBeVisible();
  }
  expect(modes).toEqual(['hour','resume','indefinite','resume']);
});
