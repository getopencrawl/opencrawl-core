import {test, expect} from '@playwright/test';
import {filePath} from '../../src/application/file-links.mjs';

test('open the published revision, copy a file link, reload it, and recheck access', async ({page}) => {
  const workspace='fixturefiles', revision='ab'.repeat(20), path='notes/launch #1.md';
  const commitLink=filePath({workspace,revision}), fileLink=filePath({workspace,revision,path});
  const shared={workspace,commit:revision,parents:[],title:'Handoff',time:'2026-11-24T00:00:00Z',author:'Engineer'};
  let allowed=true;
  await page.route('**/api/console/files/view', route=>{
    const {path: viewed}=route.request().postDataJSON();
    if (!allowed) return route.fulfill({status:404,json:{error:'Resource unavailable'}});
    return route.fulfill({json:viewed===fileLink ? {...shared,kind:'file',path,bytes:4,text:'old\n',large:false} : {...shared,kind:'commit',files:[path],truncated:false}});
  });
  await page.goto('/files');
  await expect(page).toHaveURL(url=>url.pathname===commitLink);
  const file=page.getByRole('link',{name:path});
  await expect(file).toHaveAttribute('href',fileLink);
  await file.click();
  await expect(page.locator('pre code')).toHaveText('old\n',{useInnerText:false});
  await page.reload();
  await expect(page.getByRole('heading',{name:path})).toBeVisible();
  await expect(page.getByRole('link',{name:revision})).toHaveAttribute('href',commitLink);
  allowed=false;
  await page.reload();
  await expect(page.getByText('Revision unavailable',{exact:true})).toBeVisible();
  await expect(page.locator('pre code')).toHaveCount(0);
});
