import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultSelections,selectGroup,chosen,scopeKey,updateSetupState,readSetupState,statePath,type SetupClient} from '../src/setup/state.ts';
const clients:SetupClient[]=[{id:'codex',label:'Codex',detected:true,plugin:true,forward:true,history:true,historyFiles:2,historyBytes:100},{id:'cursor',label:'Cursor',detected:true,plugin:true,forward:true,history:false,historyFiles:0,historyBytes:0}];
test('new setup defaults detected plugins and future capture on, and only available histories on',()=>{
 const choices=defaultSelections(clients);expect(chosen(choices,'plugins')).toEqual(['codex','cursor']);expect(chosen(choices,'forward')).toEqual(['codex','cursor']);expect(chosen(choices,'history')).toEqual(['codex']);
});
test('independent off choices survive reruns and legacy forward enrollment is preserved',()=>{
 const previous={plugins:{codex:true,cursor:false},forward:{codex:false,cursor:true},history:{codex:false}};
 expect(defaultSelections(clients,previous)).toEqual({...previous,history:{codex:false,cursor:false}});
 expect(chosen(defaultSelections(clients,undefined,['cursor']),'forward')).toEqual(['cursor']);
 expect(chosen({...previous,history:selectGroup('codex','history',clients,previous)},'forward')).toEqual(['cursor']);
 expect(()=>selectGroup('cursor','history',clients,previous)).toThrow();
});
test('choices are scoped to server, tenant and user; corrupt state fails closed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'opencrawl-setup-state-')),old=process.env.OPENCRAWL_CONFIG_HOME;process.env.OPENCRAWL_CONFIG_HOME=dir;
 try{
  const scope={api:'https://self.example',tenantId:'tenant-a',userId:'user-a'},selections=defaultSelections(clients);
  await updateSetupState(scope,()=>({schemaVersion:1,scope,selections,acceptedAt:new Date().toISOString()}));
  expect(readSetupState(scope)?.selections).toEqual(selections);
  for(const different of [{...scope,api:'https://cloud.example'},{...scope,tenantId:'tenant-b'},{...scope,userId:'user-b'}])expect(readSetupState(different)).toBeNull();
  writeFileSync(statePath(scopeKey(scope)),JSON.stringify({schemaVersion:1,scope:{...scope,tenantId:'forged'},selections}));
  expect(()=>readSetupState(scope)).toThrow('invalid');
 }finally{if(old===undefined)delete process.env.OPENCRAWL_CONFIG_HOME;else process.env.OPENCRAWL_CONFIG_HOME=old;rmSync(dir,{recursive:true,force:true});}
});
