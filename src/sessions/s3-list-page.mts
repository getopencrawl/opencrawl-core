import {SaxesParser} from 'saxes';
import type {StorePage} from './types.mjs';

const root='ListBucketResult';
const scalars=new Set(['KeyCount','IsTruncated','NextContinuationToken','ContinuationToken','Prefix']);
const invalid=():never=>{throw new Error('Invalid or incomplete S3 listing');};

/** Capture every listed item from a complete XML document before accepting this page as migration evidence. */
export async function completeS3Page(response:Response,prefix:string,token:string|null|undefined,maxKeys:number):Promise<Required<StorePage>>{
  const parser=new SaxesParser({xmlns:true}), stack:string[]=[], fields=new Map<string,string>();
  const keys:string[]=[],prefixes:string[]=[];
  let namespace='',value:string|undefined,item:string|undefined;
  parser.on('error',invalid);
  parser.on('doctype',invalid);
  parser.on('opentag',tag=>{
    const name=tag.local,parent=stack.at(-1);
    if(!parent){
      if(name!==root)invalid();
      namespace=tag.uri;
    }else if(tag.uri!==namespace || value!==undefined || name===root)invalid();
    if(name==='Contents'||name==='CommonPrefixes'){
      if(parent!==root)invalid();
      item=undefined;
    }else if(parent===root && scalars.has(name)){
      if(fields.has(name))invalid();
      value='';
    }else if(name==='Key'||name==='Prefix'){
      if(parent!==(name==='Key'?'Contents':'CommonPrefixes') || item!==undefined)invalid();
      value='';
    }else if(scalars.has(name))invalid();
    stack.push(name);
  });
  const append=(text:string)=>{if(value!==undefined)value+=text;};
  parser.on('text',append);
  parser.on('cdata',append);
  parser.on('closetag',tag=>{
    stack.pop();
    if(value!==undefined){
      if(stack.at(-1)===root)fields.set(tag.local,value);
      else item=value;
      value=undefined;
    }
    if(tag.local==='Contents'||tag.local==='CommonPrefixes'){
      if(!item || !item.startsWith(prefix))return invalid();
      (tag.local==='Contents'?keys:prefixes).push(item);
    }
  });
  if(!response.body)return invalid();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let size=0;
  try{
    for await(const chunk of response.body){
      size+=chunk.byteLength;
      if(size>4*1024*1024)invalid();
      parser.write(decoder.decode(chunk,{stream:true}));
    }
    parser.write(decoder.decode()).close();
  }catch{return invalid();}
  const count=fields.get('KeyCount'),truncated=fields.get('IsTruncated');
  const next=fields.get('NextContinuationToken');
  if(fields.get('Prefix')!==prefix || (fields.has('ContinuationToken') && fields.get('ContinuationToken')!==token) ||
     count!==String(keys.length+prefixes.length) || keys.length+prefixes.length>maxKeys ||
     (truncated!=='true' && truncated!=='false') ||
     (truncated==='true'? !next || next===token : next!==undefined))return invalid();
  return {keys,prefixes,nextToken:next??null};
}
