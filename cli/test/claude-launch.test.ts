import {expect,test} from 'bun:test';
import {launchClaudeSetup} from '../src/setup/claude-launch.ts';
import {setupPluginIdentity} from '../src/setup/plugins.ts';

test('native browser approval finishes before Claude receives the setup task',async()=>{
 const calls:string[][]=[];const api='http://localhost:8092';
 const code=await launchClaudeSetup('/bin/claude',{server:'plugin:'+setupPluginIdentity(api).name+':opencrawl',prompt:'continue saved setup',needsLogin:true},async(command,args)=>{calls.push([command,...args]);return 0;});
 expect(code).toBe(0);expect(calls).toEqual([
  ['/bin/claude','mcp','login',`plugin:${setupPluginIdentity(api).name}:opencrawl`],
  ['/bin/claude','continue saved setup'],
 ]);
});
test('cancelled native login never launches Claude or retries approval',async()=>{
 const calls:string[][]=[];
 expect(await launchClaudeSetup('claude',{server:'opencrawl',prompt:'continue',needsLogin:true,returnToSetup:true},async(_,args)=>{calls.push(args);return 130;})).toBe(130);
 expect(calls).toHaveLength(1);
});
test('previously observed native setup does not demand another login',async()=>{
 const calls:string[][]=[];
 await launchClaudeSetup('claude',{server:'opencrawl',prompt:'continue',needsLogin:false},async(_,args)=>{calls.push(args);return 0;});
 expect(calls).toEqual([['continue']]);
});
