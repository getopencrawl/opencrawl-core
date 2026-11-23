import {render,useApp,type Instance} from 'ink';
import {useEffect,type ReactElement} from 'react';
import {stripVTControlCharacters} from 'node:util';
import {WelcomeScreen,HostingScreen,WorkspaceScreen,NoticeScreen,type Notice,type Hosting,type WorkspaceAnswer} from './tui-view.tsx';
import {InviteScreen} from './invite-view.tsx';
import type {InviteOptions} from './invites.ts';
import {SetupSelection} from './select-view.tsx';
import type {SelectionScreen,SelectionItem} from './select.ts';

type ProgressOptions={
 animate?:boolean;
 prompt?:string;
 waiting?:{spinner:string;onSkip?:()=>void};
};

const clean=(text:string)=>stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'');
function NativeHandoff<T,>({run,resolve,reject}:{run:()=>Promise<T>;resolve:(result:T)=>void;reject:(error:unknown)=>void}){
 const {suspendTerminal}=useApp();
 useEffect(()=>{void (async()=>{let result:T|undefined;await suspendTerminal(async()=>{process.stdin.pause();result=await run();});resolve(result as T);})().catch(reject);},[run,resolve,reject,suspendTerminal]);
 return null;
}
/** One alternate-screen owner for human onboarding. No global stdout interception. */
export function createSetupUi(){
 let app:Instance|undefined,serial=0;
 const controller=new AbortController();
 const show=(node:ReactElement)=>{
  const element=<>{node}</>;
  if(app)app.rerender(element);
  else app=render(element,{stdout:process.stderr,stdin:process.stdin,stderr:process.stderr,patchConsole:false,exitOnCtrlC:false,alternateScreen:true,interactive:Boolean(process.stdin.isTTY&&process.stderr.isTTY)});
 };
 const notice=(props:Notice,key:number|'progress'=++serial)=>show(<NoticeScreen key={key} {...props} title={clean(props.title)} description={clean(props.description)} details={props.details?.map(clean)} prompt={props.prompt&&clean(props.prompt)}/>);
 const progress=(title:string,description:string,details?:string[],{animate,prompt,waiting}:ProgressOptions={})=>{
  controller.signal.throwIfAborted();
  notice({title,description,details,animate,prompt,spinner:waiting&&clean(waiting.spinner),
   ...(waiting?.onSkip&&{actions:[{id:'skip',label:'Skip for now'}],onAction:waiting.onSkip}),
   onCancel:()=>{controller.abort();notice({title:'Stopping setup',description:'Finishing the current step. Your saved choices will be kept.'});}},'progress');
 };
 const close=()=>{app?.unmount();app?.cleanup();app=undefined;};
 return {
  signal:controller.signal,progress,close,
  welcome:()=>new Promise<boolean>(resolve=>show(<WelcomeScreen key={++serial} onComplete={resolve}/>)),
  hosting:()=>new Promise<Hosting|null>(resolve=>show(<HostingScreen key={++serial} onComplete={resolve}/>)),
  workspace:()=>new Promise<WorkspaceAnswer>(resolve=>show(<WorkspaceScreen key={++serial} onComplete={resolve}/>)),
  invite:(props:InviteOptions)=>new Promise<void>(resolve=>show(<InviteScreen key={++serial} {...props} workspace={clean(props.workspace).replace(/\s+/g,' ').trim()} onContinue={resolve} onCancel={()=>{controller.abort();resolve();}}/>)),
  choose:async(screen:SelectionScreen):Promise<SelectionItem[]|null>=>{
   controller.signal.throwIfAborted();
   if(screen.phase===2&&!screen.items.length)return [];
   return new Promise(resolve=>show(<SetupSelection key={++serial} screen={screen} standalone={false} onComplete={resolve}/>));
  },
  action:(props:Omit<Notice,'onAction'|'onCancel'>)=>new Promise<string|null>(resolve=>notice({...props,onAction:resolve})),
  native:async<T,>(run:()=>Promise<T>)=>{
   try{return await new Promise<T>((resolve,reject)=>show(<NativeHandoff key={++serial} run={run} resolve={resolve} reject={reject}/>));}
   finally{progress('Checking setup','Checking the saved installation and native verification.');}
  },
 };
}
export type SetupUi=ReturnType<typeof createSetupUi>;
