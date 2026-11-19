import {useEffect,useState} from 'react';
import {Box,Text,useAnimation,useFocus,useFocusManager,useInput} from 'ink';
import TextInput from 'ink-text-input';
import {apiOrigin} from '../oauth.ts';
import {color,SetupFrame,SetupButton} from './frame.tsx';

export type Hosting='cloud'|'self-hosted';
export type WorkspaceAnswer={kind:'address';api:string}|{kind:'back'}|null;

export function WelcomeScreen({onComplete}:{onComplete:(proceed:boolean)=>void}){
 return <NoticeScreen
  title="Welcome to OpenCrawl"
  description="OpenCrawl lets you and your coding agents search your team’s past conversations. Find out why a decision was made or pick up where a teammate left off."
  details={[
   'Sign in to OpenCrawl and choose which local agents to record.',
   '\nMessages, tool results and attachments will be uploaded to your workspace and shared with your team by default. You can delete or hide sessions from your team later.',
   '\nOpenCrawl Cloud privacy settings: https://app.getopencrawl.com/sessions',
   'OpenCrawl Cloud privacy notice: https://app.getopencrawl.com/privacy',
  ]}
  actions={[{id:'continue',label:'Continue'},{id:'exit',label:'Exit'}]}
  onAction={action=>onComplete(action==='continue')}
 />;
}

export function HostingScreen({onComplete}:{onComplete:(hosting:Hosting|null)=>void}){
 const {focusNext,focusPrevious}=useFocusManager();
 useInput((input,key)=>{
  if(key.escape||(key.ctrl&&input==='c')){onComplete(null);return;}
  if(key.downArrow)focusNext();
  if(key.upArrow)focusPrevious();
 });
 return <SetupFrame title="Where is your workspace?" description="Choose how your workspace is hosted." footer={['↑ ↓ Move','Enter Select','Esc Cancel']}>
  <Box flexDirection="column" marginTop={1} gap={1}>
   <Box><SetupButton id="cloud" label="Cloud" autoFocus onPress={()=>onComplete('cloud')}/></Box>
   <Box><SetupButton id="self-hosted" label="Self-hosted" onPress={()=>onComplete('self-hosted')}/></Box>
  </Box>
 </SetupFrame>;
}

export function WorkspaceScreen({onComplete}:{onComplete:(answer:WorkspaceAnswer)=>void}){
 const [value,setValue]=useState(''),[error,setError]=useState('');
 const {isFocused}=useFocus({id:'address',autoFocus:true});
 const {focus,activeId}=useFocusManager();
 const submit=()=>{try{onComplete({kind:'address',api:apiOrigin(value.trim())});}catch{setError('Enter an HTTPS workspace address without a path.');focus('address');}};
 useInput((input,key)=>{
  if(key.ctrl&&input==='c'){onComplete(null);return;}
  if(key.escape){onComplete({kind:'back'});return;}
  if(key.downArrow&&isFocused)focus('continue');
  if(key.upArrow&&!isFocused)focus('address');
  if(!isFocused&&(key.leftArrow||key.rightArrow))focus(activeId==='continue'?'back':'continue');
 });
 return <SetupFrame title="Connect your self-hosted workspace" description="Paste the workspace address from the Setup page." footer={isFocused?['↓ Buttons','← → Edit','Enter Continue','Esc Back']:['← → Move','↑ Address','Enter Select','Esc Back']}>
  <Box flexDirection="column" marginTop={1}>
   <Text bold={isFocused}>Workspace address</Text>
   <Box borderStyle="round" borderColor={isFocused?color.accent:color.quiet} paddingX={1}>
    <TextInput value={value} focus={isFocused} onChange={next=>{setValue(next.replace(/[\r\n\u001b]/g,''));setError('');}} onSubmit={submit}/>
   </Box>
   {error&&<Text color={color.error}>{error}</Text>}
  </Box>
  <Box marginTop={1} gap={2}><SetupButton id="continue" label="Continue" onPress={submit}/><SetupButton id="back" label="Back" onPress={()=>onComplete({kind:'back'})}/></Box>
 </SetupFrame>;
}

export type SetupAction={id:string;label:string};
export type Notice={title:string;description:string;details?:string[];spinner?:string;status?:string;actions?:SetupAction[];error?:boolean;animate?:boolean;onAction?:(id:string|null)=>void;onCancel?:()=>void};
function StatusSpinner({label}:{label:string}){
 const {frame}=useAnimation({interval:100});
 const frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
 return <Box marginTop={1}><Text color={color.accent}>{frames[frame%frames.length]} {label}</Text></Box>;
}
function InstallAnimation(){
 const [frame,setFrame]=useState(0);
 useEffect(()=>{const timer=setInterval(()=>setFrame(current=>(current+1)%28),100);return()=>clearInterval(timer);},[]);
 const trail=[color.accent,color.face,color.quiet];
 return <Box marginTop={1}><Text>{Array.from({length:24},(_,index)=>{const distance=frame-index;return <Text key={index} color={distance===0?'#f7f5f6':distance>0&&distance<=3?trail[distance-1]:'#2d2835'}>━</Text>;})}</Text></Box>;
}
export function NoticeScreen({title,description,details=[],spinner,status,actions=[],error=false,animate=false,onAction,onCancel}:Notice){
 const {focusNext,focusPrevious}=useFocusManager();
 useInput((input,key)=>{
  if(key.escape||(key.ctrl&&input==='c')){if(onCancel)onCancel();else onAction?.(null);return;}
  if(key.rightArrow||key.downArrow)focusNext();
  if(key.leftArrow||key.upArrow)focusPrevious();
 });
 return <SetupFrame title={title} description={description} footer={actions.length>1?['← → Move','Enter Select','Esc Close']:actions.length===1?[`Enter ${actions[0].label}`]:onCancel?[status?'Esc Exit setup · Choices saved':'Esc Cancel']:[]}>
  {animate&&<InstallAnimation/>}
  {details.length>0&&<Box flexDirection="column" marginTop={1}>{details.map((line,index)=><Text key={index} color={error?color.error:undefined} wrap="wrap">{line}</Text>)}</Box>}
  {spinner&&<StatusSpinner label={spinner}/>}
  {status&&<Box marginTop={spinner?0:1}><Text color={color.accent} wrap="wrap">{status}</Text></Box>}
  {actions.length>0&&<Box marginTop={1} gap={2} flexWrap="wrap">{actions.map((action,index)=><SetupButton key={action.id} {...action} autoFocus={index===0} onPress={()=>onAction?.(action.id)}/>)}</Box>}
 </SetupFrame>;
}
