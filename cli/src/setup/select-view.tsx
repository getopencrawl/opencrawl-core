import {useState} from 'react';
import {Box,Text,render,useApp,useFocus,useFocusManager,useInput} from 'ink';
import {participationNotice,type SelectionItem,type SelectionScreen} from './select.ts';
import {color,SetupFrame,SetupButton as Button} from './frame.tsx';
const updatesId='setup:updates',noneId='setup:none',continueId='setup:continue',cancelId='setup:cancel';
const choiceId=(id:string)=>'setup:choice:'+id;

type ChoiceProps={id:string;label:string;detail?:string;installState?:SelectionItem['installState'];checked:boolean|'mixed';disabled?:boolean;autoFocus?:boolean;onToggle:()=>void};
function Choice({id,label,detail,installState,checked,disabled=false,autoFocus=false,onToggle}:ChoiceProps){
 const {isFocused}=useFocus({id,autoFocus,isActive:!disabled});
 useInput(input=>{if(input===' ')onToggle();},{isActive:isFocused&&!disabled});
 return <Box>
  <Box width={2}><Text color={color.accent}>{isFocused?'›':' '}</Text></Box>
  <Box width={4}><Text color={disabled?color.quiet:checked?color.accent:color.muted}>{checked==='mixed'?'[-]':checked?'[x]':'[ ]'}</Text></Box>
  <Box flexGrow={1}><Text bold={isFocused} color={disabled?color.quiet:undefined}>{label}</Text></Box>
  {installState==='installed'&&<Box marginLeft={2}><Text color={color.muted}>Installed</Text></Box>}
  {installState==='review'&&<Box marginLeft={2}><Text color={color.muted}>Review in agent</Text></Box>}
  {installState==='repair'&&<Box marginLeft={2}><Text color="yellow">⚠ Needs reinstall</Text></Box>}
  {detail&&<Box marginLeft={2}><Text color={disabled?color.quiet:color.muted}>{detail}</Text></Box>}
 </Box>;
}
export function SetupSelection({screen,onComplete,standalone=true}:{screen:SelectionScreen;onComplete:(items:SelectionItem[]|null)=>void;standalone?:boolean}){
 const [items,setItems]=useState(()=>screen.items.map(item=>({...item,selected:!item.disabled&&item.selected})));
 const [showDetails,setShowDetails]=useState(false);
 const {focus,focusNext,focusPrevious,activeId}=useFocusManager();
 const {exit}=useApp();
 const finish=(value:SelectionItem[]|null)=>{onComplete(value);if(standalone)exit();};
 const updates=screen.phase===4;
 const inButtons=activeId===continueId||activeId===cancelId;
 useInput((input,key)=>{
  if(key.escape||(key.ctrl&&input==='c')){finish(null);return;}
  if(screen.phase===1&&input==='?')setShowDetails(visible=>!visible);
  if(key.downArrow&&!inButtons)focusNext();
  if(key.upArrow){if(inButtons)focus(updates?updatesId:noneId);else focusPrevious();}
  if(inButtons&&(key.leftArrow||key.rightArrow))focus(activeId===continueId?cancelId:continueId);
 });
 const choices=items.filter(item=>item.selected);
 const selected=choices.length;
 const notice=screen.phase===1?participationNotice(choices.map(item=>item.id)):undefined;
 const first=items.find(item=>!item.disabled)?.id;
 let primary='Continue';
 if(screen.phase===2)primary=selected?'Import history':'Skip history';
 if(screen.phase===1){
  const install=choices.some(item=>item.installState==='new');
  const repair=choices.some(item=>item.installState==='repair');
  if(install&&repair)primary='Apply changes';
  else if(install)primary='Install & record';
  else if(repair)primary='Reinstall & record';
 }
 const footer=['↑ ↓ ← → Move','Space Toggle','Enter Select'];
 if(screen.phase===1)footer.push(showDetails?'? Hide details':'? What gets installed?');
 return <SetupFrame title={updates?undefined:screen.title} description={screen.description} footer={footer}>
  {updates?<Box marginTop={1}>
   <Choice id={updatesId} label={screen.title} autoFocus checked={selected>0&&selected<items.length?'mixed':selected>0}
    onToggle={()=>setItems(current=>current.map(item=>({...item,selected:selected!==items.length})))}/>
  </Box>:<Box flexDirection="column" marginTop={1}>
   {screen.phase===1&&!items.length&&<Text>No recording integrations are available for this platform.</Text>}
   {items.filter(item=>!item.disabled).map(item=><Choice key={item.id} id={choiceId(item.id)} label={item.label} installState={screen.phase===1?item.installState:undefined} detail={item.detail} checked={item.selected} disabled={item.disabled} autoFocus={item.id===first} onToggle={()=>setItems(current=>current.map(row=>row.id===item.id?{...row,selected:!row.selected}:row))}/>)}
   <Box marginTop={1}><Choice id={noneId} label={screen.noneLabel} checked={selected===0} autoFocus={!first} onToggle={()=>setItems(current=>current.map(item=>({...item,selected:false})))}/></Box>
   {items.filter(item=>item.disabled).map(item=><Choice key={item.id} id={choiceId(item.id)} label={item.label} detail={item.detail} checked={false} disabled onToggle={()=>{}}/>)}
  </Box>}
  {screen.phase===1&&showDetails&&<Box flexDirection="column" marginTop={1}>
   <Text color={color.muted}>{selected
    ? 'Selected agents get the OpenCrawl plugin to record new sessions and search your workspace. Suggestions of related work follow your workspace’s credit policy.'
    : 'No recording plugins are selected.'}</Text>
   {notice&&<Text color={color.muted}>{notice}</Text>}
  </Box>}
  <Box marginTop={1} gap={2}><Button id={continueId} label={primary} onPress={()=>finish(items)}/><Button id={cancelId} label="Cancel" onPress={()=>finish(null)}/></Box>
 </SetupFrame>;
}

export async function runSelection(screen:SelectionScreen):Promise<SelectionItem[]|null>{
 let result:SelectionItem[]|null=null;
 const app=render(<SetupSelection screen={screen} onComplete={value=>{result=value;}}/>,{stdout:process.stderr,stdin:process.stdin,stderr:process.stderr,patchConsole:false,exitOnCtrlC:false,alternateScreen:true});
 try{await app.waitUntilExit();return result;}
 finally{app.cleanup();}
}
