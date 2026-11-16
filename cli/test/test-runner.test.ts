import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('test runner isolates cached home and credentials before a real skill installation',async()=>{
  const home=mkdtempSync(join(tmpdir(),'opencrawl-test-runner-'));
  const sentinel=join(home,'.agents','skills','opencrawl','SKILL.md');mkdirSync(join(sentinel,'..'),{recursive:true});writeFileSync(sentinel,'operator-owned sentinel');
  const probe=join(home,'isolated-home.test.ts');
  writeFileSync(probe,`import {test,expect} from 'bun:test';
import {homedir} from 'node:os';
import {agentSkills} from ${JSON.stringify(resolve(import.meta.dir,'../src/skills.ts'))};
test('isolated installation',async()=>{
  expect(homedir()).not.toBe(process.env.OPENCRAWL_TEST_OPERATOR_HOME);
  expect(process.env.OPENCRAWL_CONFIG_HOME!.startsWith(homedir())).toBe(true);
  expect(process.env.OPENCRAWL_TOKEN).toBeUndefined();
  const result=await agentSkills('install','https://fixture.invalid',{clients:['codex']});
  expect(result.results.every(row=>row.directory.startsWith(homedir()))).toBe(true);
});`);
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,'../scripts/test.ts'),probe],{env:{...process.env,HOME:home,USERPROFILE:home,OPENCRAWL_TEST_OPERATOR_HOME:home,OPENCRAWL_TOKEN:'synthetic-token-must-not-leak'},stdout:'pipe',stderr:'pipe'});
  try{
    const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,output:code===0?'':out+err}).toEqual({code:0,output:''});
    expect(readFileSync(sentinel,'utf8')).toBe('operator-owned sentinel');
  }finally{child.kill();await child.exited;rmSync(home,{recursive:true,force:true});}
});
