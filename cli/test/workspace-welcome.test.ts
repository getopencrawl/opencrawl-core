import {test,expect} from 'bun:test';
import {workspaceWelcome} from '../src/cli.ts';

test('optional workspace welcome uses the current deployment and terminal-safe labels',()=>{
  const api='https://cloud.example';
  const welcome={path:'/setup?welcome=starter&workspace=org_new',title:'Workspace ready',detail:'Review your plan.',openLabel:'Open checkout',skipLabel:'Continue on Free'};
  const {path,...labels}=welcome;
  expect(workspaceWelcome(api,welcome)).toEqual({...labels,url:api+path});
  for(const candidate of [undefined,null,{}, {...welcome,path:'https://outside.example'}, {...welcome,path:'//outside.example'},
      {...welcome,title:'workspace\nredirect'}, {...welcome,skipLabel:''}]) expect(workspaceWelcome(api,candidate)).toBeUndefined();
});
