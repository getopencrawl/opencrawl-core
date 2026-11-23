import {test,expect} from 'bun:test';
import {render} from 'ink-testing-library';
import {pressAndRead,renderReady,waitForFrame} from './setup-ink.ts';
import {SetupSelection} from '../src/setup/select-view.tsx';
import {chooseSetupItems,type SelectionItem,type SelectionScreen} from '../src/setup/select.ts';
const screen:SelectionScreen={phase:1,title:'Record new sessions',description:'Connect and record selected agents.',noneLabel:'Do not record any sessions on this machine',items:[{id:'claude-code',label:'Claude Code',installState:'installed',selected:true},{id:'codex',label:'Codex',detail:'Detected',installState:'repair',selected:true},{id:'antigravity',label:'Antigravity',detail:'Not detected',disabled:true,selected:false},{id:'cursor',label:'Cursor',installState:'new',selected:false}]};
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
const down='\u001b[B',up='\u001b[A',right='\u001b[C',enter='\r';
test('arrow navigation, Space checkboxes, exclusive opt-out and Enter on the focused button',async()=>{
 let answer:SelectionItem[]|null|undefined;const app=await renderReady(<SetupSelection screen={screen} onComplete={value=>{answer=value;}}/>);
 try{
  await waitForFrame(app,'› [x] Claude Code');
  expect(app.lastFrame()).not.toContain('sharing instructions');
  await pressAndRead(app,'?','? Hide details');
  expect(app.lastFrame()?.replace(/\s+/g,' ')).toContain('sharing instructions to Claude Code and Codex.');
  expect(app.lastFrame()?.replace(/\s+/g,' ')).toContain('workspace’s credit policy');
  expect(app.lastFrame()).toMatch(/Codex[^\n]*⚠ Needs reinstall/);
  expect(app.lastFrame()).toContain('Reinstall & record');
  expect(app.lastFrame()!.indexOf('Antigravity')).toBeGreaterThan(app.lastFrame()!.indexOf('Do not record'));
  await pressAndRead(app,' ','› [ ] Claude Code');expect(answer).toBeUndefined();
  expect(app.lastFrame()).toContain('sharing instructions to Codex.');
  expect(app.lastFrame()).not.toContain('Claude Code also allows');
  await pressAndRead(app,down,'› [x] Codex');
  await pressAndRead(app,down,'› [ ] Cursor');
  await pressAndRead(app,down,'› [ ] Do not record');
  await pressAndRead(app,' ','› [x] Do not record');
  expect(app.lastFrame()).toContain('[ ] Codex');
  expect(app.lastFrame()).not.toContain('sharing instructions');
  expect(app.lastFrame()).toContain('No recording plugins are selected.');
  await pressAndRead(app,'?','? What gets installed?');
  expect(app.lastFrame()).not.toContain('No recording plugins are selected.');
  await pressAndRead(app,down,'› [ Continue ]');expect(answer).toBeUndefined();
  await pressAndRead(app,right,'› [ Cancel ]');
  await pressAndRead(app,up,'› [x] Do not record');
  await pressAndRead(app,down,'› [ Continue ]');app.stdin.write(enter);await tick();
  expect(answer?.every(item=>!item.selected)).toBe(true);
 }finally{app.unmount();}
});
test('intact Claude Code and Codex installations can continue without a reinstall',async()=>{
 const items=screen.items.slice(0,2).map(item=>({...item,installState:'installed' as const}));
 const app=await renderReady(<SetupSelection screen={{...screen,items}} onComplete={()=>{}}/>);
 try{
  const frame=app.lastFrame();
  expect(frame).toMatch(/Claude Code[^\n]*Installed/);
  expect(frame).toMatch(/Codex[^\n]*Installed/);
  expect(frame).toContain('[ Continue ]');
  expect(frame).not.toMatch(/reinstall/i);
 }finally{app.unmount();}
});
test('history starts unchecked and only Enter on its button commits',async()=>{
 let answer:SelectionItem[]|null|undefined;const history:SelectionScreen={...screen,phase:2,title:'Import past sessions',noneLabel:'Skip history import',items:[{id:'codex',label:'Codex',selected:false,detail:'3 files'}]};
 const app=render(<SetupSelection screen={history} onComplete={value=>{answer=value;}}/>);
 try{
  await tick();app.stdin.write(enter);await tick();expect(answer).toBeUndefined();
  app.stdin.write(' ');await tick();expect(app.lastFrame()).toContain('› [x] Codex');
  app.stdin.write(down);await tick();app.stdin.write(down);await tick();expect(app.lastFrame()).toContain('› [ Import history ]');
  app.stdin.write(enter);await tick();expect(answer?.[0].selected).toBe(true);
 }finally{app.unmount();}
});
test('Cancel and Ctrl+C return no approval',async()=>{
 for(const cancel of ['button','interrupt']){
  let answer:SelectionItem[]|null|undefined;const app=render(<SetupSelection screen={screen} onComplete={value=>{answer=value;}}/>);
  try{await tick();if(cancel==='button'){for(let i=0;i<4;i++){app.stdin.write(down);await tick();}app.stdin.write(right);await tick();app.stdin.write(enter);}else app.stdin.write('\u0003');await tick();expect(answer).toBeNull();}finally{app.unmount();}
 }
});
test('empty history does not open another interactive screen',async()=>{
 expect(await chooseSetupItems({...screen,phase:2,items:[],emptyMessage:'No history found.'})).toEqual([]);
});

const updateLabel='Keep OpenCrawl plugins up to date (Recommended)';
test('one checkbox controls updates for selected recording agents',async()=>{
 const items=screen.items.slice(0,2).map(item=>({...item,selected:false,autoUpdate:false}));
 let answer:SelectionItem[]|null|undefined;
 const app=await renderReady(<SetupSelection screen={{...screen,items}} onComplete={value=>{answer=value;}}/>);
 try{
  expect(app.lastFrame()).not.toContain(updateLabel);
  await pressAndRead(app,' ','[ ] '+updateLabel);
  await pressAndRead(app,down,'› [ ] Codex');
  await pressAndRead(app,down,'› [ ] Do not record');
  await pressAndRead(app,down,'› [ ] '+updateLabel);
  await pressAndRead(app,' ','› [x] '+updateLabel);
  await pressAndRead(app,up,'› [ ] Do not record');
  await pressAndRead(app,up,'› [ ] Codex');
  await pressAndRead(app,' ','› [x] Codex');
  expect(app.lastFrame()).toContain('[x] '+updateLabel);
  await pressAndRead(app,down,'› [ ] Do not record');
  await pressAndRead(app,down,'› [x] '+updateLabel);
  await pressAndRead(app,' ','› [ ] '+updateLabel);
  await pressAndRead(app,down,'› [ Reinstall & record ]');
  app.stdin.write(enter);await tick();
  expect(answer?.map(item=>[item.selected,item.autoUpdate])).toEqual([[true,false],[true,false]]);
 }finally{app.unmount();}
});

test('continuing with mixed saved update choices preserves each agent’s choice',async()=>{
 const items=screen.items.slice(0,2).map(item=>({...item,selected:true,autoUpdate:item.id==='codex'}));
 let answer:SelectionItem[]|null|undefined;
 const app=await renderReady(<SetupSelection screen={{...screen,items}} onComplete={value=>{answer=value;}}/>);
 try{
  await waitForFrame(app,'[-] '+updateLabel);
  await pressAndRead(app,down,'› [x] Codex');
  await pressAndRead(app,down,'› [ ] Do not record');
  await pressAndRead(app,down,'› [-] '+updateLabel);
  await pressAndRead(app,down,'› [ Reinstall & record ]');
  app.stdin.write(enter);await tick();
  expect(answer).toEqual(items);
 }finally{app.unmount();}
});
