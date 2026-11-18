import {expect,test} from 'bun:test';
import {launchCodexSetup} from '../src/setup/codex-launch.ts';
import {setupPluginIdentity} from '../src/setup/plugins.ts';

test('Codex native OAuth precedes the saved setup task without trust overrides',async()=>{
 const calls:string[][]=[],api='http://localhost:8092';
 expect(await launchCodexSetup('/native/codex',{server:setupPluginIdentity(api).name,prompt:'continue saved choices',needsLogin:true},async(command,args)=>{calls.push([command,...args]);return 0;},()=>{})).toBe(0);
 expect(calls).toEqual([['/native/codex','mcp','login',setupPluginIdentity(api).name],['/native/codex','continue saved choices']]);
});
test('Codex login cancellation does not launch a model or retry approval',async()=>{
 let calls=0;
 expect(await launchCodexSetup('codex',{server:'opencrawl',prompt:'continue',needsLogin:true},async()=>{calls++;return 130;},()=>{})).toBe(130);
 expect(calls).toBe(1);
});
test('previously observed Codex connection skips another login',async()=>{
 const calls:string[][]=[];
 await launchCodexSetup('codex',{server:'opencrawl',prompt:'continue',needsLogin:false},async(_,args)=>{calls.push(args);return 0;},()=>{});
 expect(calls).toEqual([['continue']]);
});
