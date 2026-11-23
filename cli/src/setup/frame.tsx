import type {ReactNode} from 'react';
import {Box,Text,useFocus,useInput,useWindowSize} from 'ink';

// OpenCrawl Night. Shared by every interactive setup screen only.
export const color={accent:'#a3a6ff',face:'#7d82ff',ink:'#0c0d2a',surface:'#17151d',muted:'#b9b4c0',quiet:'#8a8492',error:'#ff9494'};
export function SetupFrame({title,description,children,footer}:{title?:string;description?:string;children?:ReactNode;footer:readonly string[]}){
 const {columns,rows}=useWindowSize();
 return <Box flexDirection="column" width={columns} minHeight={rows} paddingX={2} paddingY={1}>
  <Box flexDirection="column" width="100%" maxWidth={72} flexShrink={0}>
   <Box><Text bold color={color.accent}>OpenCrawl</Text></Box>
   {title&&<Box marginTop={1}><Text bold>{title}</Text></Box>}
   {description&&<Box marginTop={1}><Text color={color.muted}>{description}</Text></Box>}
   {children}
  </Box>
  {footer.length>0&&<>
   <Box flexGrow={1} minHeight={1}/>
   <Box justifyContent={footer.length===1?'flex-end':'space-between'} flexWrap="wrap" columnGap={2} flexShrink={0}>
    {footer.map(hint=><Box key={hint} flexShrink={0} maxWidth={Math.max(1,columns-4)}><Text color={color.quiet}>{hint}</Text></Box>)}
   </Box>
  </>}
 </Box>;
}
export function SetupButton({id,label,onPress,autoFocus=false}:{id:string;label:string;onPress:()=>void;autoFocus?:boolean}){
 const {isFocused}=useFocus({id,autoFocus});
 useInput((_input,key)=>{if(key.return)onPress();},{isActive:isFocused});
 return <Text bold={isFocused} color={isFocused?color.ink:color.muted} backgroundColor={isFocused?color.face:undefined}>{` ${isFocused?'› ':'  '}[ ${label} ] `}</Text>;
}
