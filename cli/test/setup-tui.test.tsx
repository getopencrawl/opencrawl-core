import {InviteScreen} from '../src/setup/invite-view.tsx';
import {test,expect} from 'bun:test';
import {fileURLToPath} from 'node:url';
import {render} from 'ink-testing-library';
import {pressAndRead,renderReady,waitForFrame} from './setup-ink.ts';
import {WelcomeScreen,HostingScreen,WorkspaceScreen,NoticeScreen,type Hosting,type WorkspaceAnswer} from '../src/setup/tui-view.tsx';

const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
const down='\u001b[B',up='\u001b[A',right='\u001b[C',enter='\r';
test.skipIf(process.platform==='win32')('the install bar keeps moving through rapid task updates',async()=>{
 const module=fileURLToPath(new URL('../src/setup/tui.tsx',import.meta.url));
 const script=`
  import {createSetupUi} from ${JSON.stringify(module)};
  const ui=createSetupUi();
  try {
   for(let task=0;task<20;task++){
    ui.progress('Installing','Task '+task,undefined,true);
    await Bun.sleep(40);
   }
  } finally { ui.close(); }
 `;
 const decoder=new TextDecoder();
 let output='';
 const child=Bun.spawn([process.execPath,'-e',script],{
  env:{...process.env,FORCE_COLOR:'3',TERM:'xterm-256color'},
  terminal:{cols:80,rows:24,data(_terminal,data){output+=decoder.decode(data,{stream:true});}}
 });
 try{
  expect(await child.exited).toBe(0);
  expect(output).toContain('Task 19');
  const barFrames=output.split(/\r?\n/).filter(line=>line.includes('━'));
  // The bar uses color to move its highlight. A remount on each task
  // repeats the first colored line even while the task text changes.
  expect(new Set(barFrames).size).toBeGreaterThan(3);
 }finally{child.terminal?.close();}
});
test('welcome explains recording, sharing and privacy controls before Continue or Exit',async()=>{
 for(const key of ['continue','exit','escape','interrupt']){
  let proceed:boolean|undefined;
  const app=await renderReady(<WelcomeScreen onComplete={value=>{proceed=value;}}/>);
  try{
   await waitForFrame(app,'› [ Continue ]');
   const frame=app.lastFrame()!.replace(/\s+/g,' ');
   expect(frame).toContain('OpenCrawl lets you and your coding agents search your team’s past conversations. Find out why a decision was made or pick up where a teammate left off.');
   expect(frame).toContain('Sign in to OpenCrawl and choose which local agents to record.');
   expect(frame).toContain('Messages, tool results and attachments will be uploaded to your workspace and shared with your team by default. You can delete or hide sessions from your team later.');
   expect(frame).toContain('OpenCrawl Cloud privacy settings: https://app.getopencrawl.com/sessions');
   expect(frame).toContain('OpenCrawl Cloud privacy notice: https://app.getopencrawl.com/privacy');
   if(key==='exit')await pressAndRead(app,right,'› [ Exit ]');
   app.stdin.write(key==='escape'?'\u001b':key==='interrupt'?'\u0003':enter);
   await tick();expect(proceed).toBe(key==='continue');
  }finally{app.unmount();}
 }
});
test('setup hints span the bottom row and wrap as whole shortcuts on resize',async()=>{
 const app=render(<HostingScreen onComplete={()=>{}}/>);
 try{
  await tick();
  const resize=async(columns:number)=>{
   Object.defineProperties(app.stdout,{columns:{configurable:true,value:columns},rows:{configurable:true,value:24}});
   app.stdout.emit('resize');await tick();
   return app.lastFrame()!.split('\n');
  };
  const wide=await resize(90),line=wide[22]!;
  expect(line.slice(2,10)).toBe('↑ ↓ Move');
  expect(line.trimEnd().length).toBe(88);
  expect(line.indexOf('Enter Select')).toBeGreaterThan(30);
  expect(line.trimEnd().endsWith('Esc Cancel')).toBe(true);
  const narrow=await resize(28);
  expect(narrow[21]).toContain('↑ ↓ Move');
  expect(narrow[21]).toContain('Enter Select');
  expect(narrow[22]).toContain('Esc Cancel');
  app.rerender(<NoticeScreen title="Installing" description="Installing the plugin." onCancel={()=>{}}/>);
  await tick();expect(app.lastFrame()!.split('\n')[22]).toBe(' '.repeat(16)+'Esc Cancel');
 }finally{app.unmount();}
});
test('hosting is a single choice selected with arrows and Enter, with cancellation',async()=>{
 for(const choice of ['cloud','self-hosted',null] as const){
  let answer:Hosting|null|undefined;const app=render(<HostingScreen onComplete={value=>{answer=value;}}/>);
  try{
   await tick();app.stdin.write(' ');await tick();expect(answer).toBeUndefined();
   if(choice==='self-hosted'){app.stdin.write(down);await tick();}
   app.stdin.write(choice===null?'\u001b':enter);await tick();expect(answer).toBe(choice);
  }finally{app.unmount();}
 }
});
test('workspace entry pastes and edits an origin, validates in place, then submits',async()=>{
 let answer:WorkspaceAnswer|undefined;
 const app=await renderReady(<WorkspaceScreen onComplete={value=>{answer=value;}}/>);
 try{
  await waitForFrame(app,'↓ Buttons');
  const address='https://example.test/setup';
  await pressAndRead(app,'\u001b[200~'+address+'\u001b[201~',address);
  await pressAndRead(app,enter,'without a path');expect(answer).toBeUndefined();
  for(let length=address.length-1;length>='https://example.test'.length;length--){
   await pressAndRead(app,'\u007f',address.slice(0,length)+' ');
  }
  await pressAndRead(app,down,'› [ Continue ]');
  app.stdin.write(enter);await tick();expect(answer).toEqual({kind:'address',api:'https://example.test'});
 }finally{app.unmount();}
});
test('workspace Back and Escape return to hosting; Ctrl+C cancels without a destination',async()=>{
 for(const method of ['button','escape','interrupt']){
  let answer:WorkspaceAnswer|undefined;const app=render(<WorkspaceScreen onComplete={value=>{answer=value;}}/>);
  try{
   await tick();
   if(method==='button'){
    app.stdin.write(down);await tick();app.stdin.write(right);await tick();expect(app.lastFrame()).toContain('› [ Back ]');
    app.stdin.write(up);await tick();expect(app.lastFrame()).not.toContain('› [ Back ]');
    app.stdin.write(down);await tick();app.stdin.write(right);await tick();app.stdin.write(enter);
   }else app.stdin.write(method==='escape'?'\u001b':'\u0003');
   await tick();expect(answer).toEqual(method==='interrupt'?null:{kind:'back'});
  }finally{app.unmount();}
 }
});
test('waiting screen cancels and error actions use the same arrow and Enter behavior',async()=>{
 let cancelled=false,answer:string|null|undefined;
 const waiting=render(<NoticeScreen title="Sign in" description="Approve in your browser." onCancel={()=>{cancelled=true;}}/>);
 try{await tick();waiting.stdin.write('\u001b');await tick();expect(cancelled).toBe(true);}finally{waiting.unmount();}
 const error=render(<NoticeScreen title="Setup needs attention" description="Try again." actions={[{id:'retry',label:'Retry'},{id:'close',label:'Close'}]} onAction={value=>{answer=value;}}/>);
 try{await tick();error.stdin.write(right);await tick();error.stdin.write(enter);await tick();expect(answer).toBe('close');}finally{error.unmount();}
});

test('the hook trust spinner animates with Skip for now as its only button',async()=>{
 const pressed:(string|null)[]=[];
 const app=await renderReady(<NoticeScreen title="Trust hooks" description="Codex Desktop or CLI" spinner="Checking trust…" actions={[{id:'skip',label:'Skip for now'}]} onAction={id=>pressed.push(id)}/>);
 try{
  await waitForFrame(app,'› [ Skip for now ]');
  await waitForFrame(app,'⠙ Checking trust…');
  expect(app.lastFrame()?.match(/\[ [^\]]+ \]/g)).toEqual(['[ Skip for now ]']);
  app.stdin.write(enter);await tick();
  expect(pressed).toEqual(['skip']);
 }finally{app.unmount();}
});

test('invite screen validates, sends once, allows another address, and skips without submitting a draft',async()=>{
 const emails:string[]=[];
 let continued=0,release!:()=>void;
 const app=await renderReady(<InviteScreen workspace="Example Team" delivery="email" send={async email=>{emails.push(email);await new Promise<void>(resolve=>{release=resolve;});}} onContinue={()=>{continued++;}} onCancel={()=>{throw Error('Unexpected cancellation');}}/>);
 try{
  await pressAndRead(app,'alice','alice');
  await pressAndRead(app,enter,'Enter one valid email address.');
  await pressAndRead(app,'@example.test','alice@example.test');
  await pressAndRead(app,enter,'Inviting…');
  app.stdin.write(enter);await tick();expect(emails).toEqual(['alice@example.test']);
  release();await waitForFrame(app,'Invitation sent to alice@example.test.');
  await pressAndRead(app,'bob@example.test','bob@example.test');
  app.stdin.write('\u001b');await tick();expect(continued).toBe(1);expect(emails).toHaveLength(1);
 }finally{app.unmount();}
});
test('an empty invite prompt continues without an email or a private link',async()=>{
 let continued=false;
 const app=await renderReady(<InviteScreen workspace="Example Team" delivery="link" send={async()=>{throw Error('Unexpected invitation');}} onContinue={()=>{continued=true;}} onCancel={()=>{}}/>);
 try{await waitForFrame(app,'Create invite link');app.stdin.write(enter);await tick();expect(continued).toBe(true);}finally{app.unmount();}
});
