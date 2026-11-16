import {emitKeypressEvents} from 'node:readline';
export type SelectionItem={id:string;label:string;selected:boolean;secondary?:boolean};
export type SelectionScreen={title:string;description:string;items:SelectionItem[];secondaryLabel?:string;emptyMessage?:string};
export type SelectionCursor={items:SelectionItem[];index:number;column:0|1};
export type SelectionKey='up'|'down'|'left'|'right'|'space'|'a'|'n';
export function applySelectionKey(state:SelectionCursor,key:SelectionKey):SelectionCursor{
 const items=state.items.map(item=>({...item}));let {index,column}=state;
 if(!items.length)return {items,index:0,column};
 if(key==='up')index=(index+items.length-1)%items.length;
 if(key==='down')index=(index+1)%items.length;
 if(key==='left')column=0;
 if(key==='right'&&items.some(item=>item.secondary!==undefined))column=1;
 const field=column===1?'secondary':'selected';
 const select=(item:SelectionItem,value:boolean)=>{item[field]=value;if(field==='selected'&&!value&&item.secondary!==undefined)item.secondary=false;if(field==='secondary'&&value)item.selected=true;};
 if(key==='space'&&items[index][field]!==undefined)select(items[index],!items[index][field]);
 if(key==='a'||key==='n')for(const item of items)if(item[field]!==undefined)select(item,key==='a');
 return {items,index,column};
}
/** Native terminal keyboard selection; Enter is the single confirmation for this screen. */
export async function chooseSetupItems(screen:SelectionScreen):Promise<SelectionItem[]|null>{
 if(!screen.items.length){process.stderr.write(screen.title+'\n'+screen.description+'\n'+(screen.emptyMessage??'No available choices.')+'\n');return [];}
 const input=process.stdin,output=process.stderr;
 if(!input.isTTY||!output.isTTY)throw new Error('Interactive setup requires a terminal. Use setup --json.');
 let state:SelectionCursor={items:screen.items.map(item=>({...item})),index:0,column:0},lines=0;
 const render=()=>{
  if(lines)output.write(`\u001b[${lines}A\u001b[0J`);
  const content=[screen.title,screen.description,...state.items.map((item,index)=>`${index===state.index?'>':' '} [${item.selected?'x':' '}] ${item.label}${item.secondary===undefined?'':`  ${screen.secondaryLabel??'Record new'} [${item.secondary?'x':' '}]${index===state.index&&state.column===1?' <':''}`}`),`↑/↓ move | Space toggle${screen.secondaryLabel?' | ←/→ plugin/record':''} | A all | N none | Enter confirm | Esc cancel`];
  const width=Math.max(30,output.columns||80),text=content.flatMap(line=>line.split('\n').flatMap(part=>{const rows:string[]=[];while(part.length>width){const split=part.lastIndexOf(' ',width);const end=split>0?split:width;rows.push(part.slice(0,end));part=part.slice(end).trimStart();}rows.push(part);return rows;}));
  output.write(text.join('\n')+'\n');lines=text.length;
 };
 emitKeypressEvents(input);const wasRaw=input.isRaw;input.setRawMode(true);input.resume();output.write('\u001b[?25l');render();
 try{return await new Promise(resolve=>{
  const finish=(value:SelectionItem[]|null)=>{input.off('keypress',onKey);resolve(value);};
  const onKey=(text:string,key:{name?:string;ctrl?:boolean})=>{
   if(key.name==='escape'||key.ctrl&&['c','d'].includes(key.name??''))return finish(null);
   if(key.name==='return'||key.name==='enter')return finish(state.items);
   const name=key.name==='space'?'space':key.name??text.toLowerCase();
   if(['up','down','left','right','space','a','n'].includes(name)){state=applySelectionKey(state,name as SelectionKey);render();}
  };
  input.on('keypress',onKey);
 });}finally{input.setRawMode(wasRaw??false);input.pause();output.write('\u001b[?25h');}
}
