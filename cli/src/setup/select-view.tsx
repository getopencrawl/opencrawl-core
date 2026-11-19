import {useState} from 'react';
import {Box,Text,render,useApp,useFocus,useFocusManager,useInput} from 'ink';
import type {SelectionItem,SelectionScreen} from './select.ts';
import {color,SetupFrame,SetupButton as Button} from './frame.tsx';
const noneId='setup:none',continueId='setup:continue',cancelId='setup:cancel';
const choiceId=(id:string)=>'setup:choice:'+id;

type ChoiceProps={id:string;label:string;detail?:string;needsReinstall?:boolean;checked:boolean;disabled?:boolean;autoFocus?:boolean;onToggle:()=>void};
function Choice({id,label,detail,needsReinstall,checked,disabled=false,autoFocus=false,onToggle}:ChoiceProps){
 const {isFocused}=useFocus({id,autoFocus,isActive:!disabled});
 useInput(input=>{if(input===' ')onToggle();},{isActive:isFocused&&!disabled});
 return <Box>
  <Box width={2}><Text color={color.accent}>{isFocused?'›':' '}</Text></Box>
  <Box width={4}><Text color={disabled?color.quiet:checked?color.accent:color.muted}>{checked?'[x]':'[ ]'}</Text></Box>
  <Box flexGrow={1}><Text bold={isFocused} color={disabled?color.quiet:undefined}>{label}</Text></Box>
  {needsReinstall&&<Box marginLeft={2}><Text color="yellow">⚠ Needs reinstall</Text></Box>}
  {detail&&<Box marginLeft={2}><Text color={disabled?color.quiet:color.muted}>{detail}</Text></Box>}
 </Box>;
}
export function SetupSelection({screen,onComplete,standalone=true}:{screen:SelectionScreen;onComplete:(items:SelectionItem[]|null)=>void;standalone?:boolean}){
 const [items,setItems]=useState(()=>screen.items.map(item=>({...item,selected:!item.disabled&&item.selected})));
 const {focus,focusNext,focusPrevious,activeId}=useFocusManager();
 const {exit}=useApp();
 const finish=(value:SelectionItem[]|null)=>{onComplete(value);if(standalone)exit();};
 const inButtons=activeId===continueId||activeId===cancelId;
 useInput((input,key)=>{
  if(key.escape||(key.ctrl&&input==='c')){finish(null);return;}
  if(key.downArrow&&!inButtons)focusNext();
  if(key.upArrow){if(inButtons)focus(noneId);else focusPrevious();}
  if(inButtons&&(key.leftArrow||key.rightArrow))focus(activeId===continueId?cancelId:continueId);
 });
 const selected=items.filter(item=>item.selected).length;
 const first=items.find(item=>!item.disabled)?.id;
 const reinstall=items.some(item=>item.selected&&item.needsReinstall);
 const primary=screen.phase===3?'Continue':screen.phase===1?(reinstall?'Reinstall & record':selected?'Install & record':'Continue'):(selected?'Import history':'Skip history');
 return <SetupFrame title={screen.title} description={screen.description} footer={['↑ ↓ ← → Move','Space Toggle','Enter Select']}>
  <Box flexDirection="column" marginTop={1}>
   {items.map(item=><Choice key={item.id} id={choiceId(item.id)} label={item.label} needsReinstall={screen.phase===1&&item.needsReinstall} detail={screen.phase===2?item.detail:undefined} checked={item.selected} disabled={item.disabled} autoFocus={item.id===first} onToggle={()=>setItems(current=>current.map(row=>row.id===item.id?{...row,selected:!row.selected}:row))}/>)}
   <Box marginTop={1}><Choice id={noneId} label={screen.noneLabel} checked={selected===0} autoFocus={!first} onToggle={()=>setItems(current=>current.map(item=>({...item,selected:false})))}/></Box>
  </Box>
  <Box marginTop={1} gap={2}><Button id={continueId} label={primary} onPress={()=>finish(items)}/><Button id={cancelId} label="Cancel" onPress={()=>finish(null)}/></Box>
 </SetupFrame>;
}

export async function runSelection(screen:SelectionScreen):Promise<SelectionItem[]|null>{
 let result:SelectionItem[]|null=null;
 const app=render(<SetupSelection screen={screen} onComplete={value=>{result=value;}}/>,{stdout:process.stderr,stdin:process.stdin,stderr:process.stderr,patchConsole:false,exitOnCtrlC:false,alternateScreen:true});
 try{await app.waitUntilExit();return result;}
 finally{app.cleanup();}
}
