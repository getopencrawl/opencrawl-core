import {expect,test} from 'bun:test';
import {runInteractiveSetup} from '../src/setup/interactive.ts';
import type {SetupUi} from '../src/setup/tui.tsx';
import {DEFAULT_API_ORIGIN} from '../src/oauth.ts';

const unexpected=async():Promise<never>=>{throw Error('Unexpected question');};
const ui=(override:Partial<SetupUi>):SetupUi=>({signal:new AbortController().signal,welcome:async()=>true,hosting:unexpected,workspace:unexpected,invite:unexpected,progress:()=>{},choose:unexpected,action:unexpected,close:()=>{},native:async run=>run(),...override});

test('Cloud skips address entry, and an explicit destination skips both questions',async()=>{
 for(const supplied of [false,true]){
  const expected=supplied?'https://self-host.example.test':DEFAULT_API_ORIGIN;let calls=0;
  const result=await runInteractiveSetup({values:{},readDestination:()=>supplied?{api:expected,explicit:expected}:{},withOrigin:async(origin,run)=>{expect(origin).toBe(expected);return run();},login:unexpected},{createUi:()=>ui(supplied?{}:{hosting:async()=>'cloud'}),setup:async(action,api)=>{calls++;expect(action).toBe('run');expect(api).toBe(expected);return {status:'cancelled',humanTasks:[]};}});
  expect(result).toBe(0);expect(calls).toBe(1);
 }
});

test('Back returns to hosting and cancelling hosting never starts a network operation',async()=>{
 for(const cancel of [false,true]){
  let choices=0,addresses=0,operations=0;
  const result=await runInteractiveSetup({values:{},readDestination:()=>({}),withOrigin:async(origin,run)=>{operations++;expect(origin).toBe(DEFAULT_API_ORIGIN);return run();},login:unexpected},{createUi:()=>ui({hosting:async()=>{choices++;return choices===1?'self-hosted':cancel?null:'cloud';},workspace:async()=>{addresses++;return {kind:'back'};}}),setup:async()=>({status:'cancelled',humanTasks:[]})});
  expect(result).toBe(0);expect(choices).toBe(2);expect(addresses).toBe(1);expect(operations).toBe(cancel?0:1);
 }
});

test('exiting the welcome screen closes setup before reading a destination or connecting',async()=>{
 const steps:string[]=[];
 const code=await runInteractiveSetup({
  values:{},readDestination:()=>{throw Error('Unexpected destination read');},withOrigin:unexpected,login:unexpected,
 },{
  createUi:()=>ui({welcome:async()=>{steps.push('welcome');return false;},close:()=>{steps.push('close');}}),
  setup:unexpected,
 });
 expect(code).toBe(0);
 expect(steps).toEqual(['welcome','close']);
});
