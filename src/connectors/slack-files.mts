import type {ConnectorBinding, ConnectorStore, ConnectorDocument, AirbyteEnvelope, SlackFileRecord, ExtractionResult, DocumentItem} from './types.mjs';
import {createHash} from 'node:crypto';
import {validateBinding,documentId,digest,invalidRecord} from './scope.mjs';
import {extractDocumentText} from './document-text.mjs';

const id=(value: unknown): value is string=>typeof value==='string'&&/^[A-Z][A-Z0-9]{1,100}$/.test(value);
const hash=(bytes: Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const label=(value: unknown): string=>{if(value===undefined||value===null)return '';if(typeof value!=='string'||Buffer.byteLength(value)>256*1024)invalidRecord('Invalid file label');return value;};
/** Lossless, bounded chunks. Overlap keeps ordinary phrases crossing a boundary
 * searchable; offsets describe the non-overlapping coverage of the source part. */
export function textChunks(text: string, maxBytes=128*1024) {
 if(typeof text!=='string'||!Number.isInteger(maxBytes)||maxBytes<1024)throw new Error('Invalid text chunk input');
 const result: {text: string; start: number; end: number}[]=[];let start=0,offset=0,bytes=0; let characters: string[]=[];
 for(const character of text){const size=Buffer.byteLength(character);if(bytes+size>maxBytes&&characters.length){result.push({text:characters.join(''),start,end:offset});start=offset;characters=[];bytes=0;}characters.push(character);bytes+=size;offset+=character.length;}
 if(characters.length)result.push({text:characters.join(''),start,end:offset});
 return result.map((part,i)=>{const overlap=i?[...result[i-1].text].slice(-256).join(''):'';return {...part,text:overlap+part.text,overlap:overlap.length};});
}

/** Portable file_documents v1 envelope. The source adapter must verify current
 * public-channel sharing and persist immutable bytes before emitting a record. */
export async function normalizeSlackFile(binding: ConnectorBinding,envelope: AirbyteEnvelope<SlackFileRecord>,sourceKey: string,{store,extract=extractDocumentText}: {store?: ConnectorStore; extract?: (bytes: Uint8Array, options: {mediaType: string}) => Promise<ExtractionResult>}={}) {
 validateBinding(binding);const data=envelope?._airbyte_data,extractedAt=envelope?._airbyte_extracted_at;
 if(!data||data.format_version!==1||!id(data.id)||!id(data.channel_id)||!Number.isSafeInteger(extractedAt)||extractedAt<0||envelope._airbyte_meta?.changes?.length)invalidRecord('Invalid Slack file envelope');
 if(typeof data.available!=='boolean')invalidRecord('File availability is required');
 const sourceId=data.channel_id+':'+data.id;
 const common={tenantId:binding.tenantId,connectionId:binding.connectionId,workspaceId:binding.workspaceId,provider:'slack',channelId:data.channel_id,threadTs:'',timestamp:'',authorId:label(data.user),title:label(data.title||data.name),extractedAt,deleted:false,sourceKey,publicChannel:false,fileId:data.id};
 let result: ExtractionResult={status:'unavailable',parts:[]}; let fileVersion='';
 if(data.available){
  if(typeof data.media_type!=='string')invalidRecord('Missing file media type');
  if(data.media_type.startsWith('image/'))result={status:'image-no-ocr',parts:[]};
  else{
   if(!/^[a-f0-9]{64}$/.test(data.content_sha256||'')||data.content_key!==binding.rawPrefix+'files/sha256/'+data.content_sha256+'.bin'||!Number.isSafeInteger(data.content_bytes)||data.content_bytes!<1||data.content_bytes!>20*1024*1024)invalidRecord('Invalid scoped file content reference');
   const bytes=await store!.get(data.content_key!,{maxBytes:20*1024*1024});
   if(!bytes||bytes.length!==data.content_bytes||hash(bytes)!==data.content_sha256)invalidRecord('File content checksum mismatch');
   result=await extract(bytes,{mediaType:data.media_type});
   if(!['extracted','no-text-layer'].includes(result.status))invalidRecord('File extraction is incomplete');
  }
  const apiParts=data.api_text||[];
  if(!Array.isArray(apiParts)||apiParts.length>20000)invalidRecord('Invalid file API text');
  for(const part of apiParts) {
   if(!part||typeof part.path!=='string'||part.path.length>500||typeof part.text!=='string'||Buffer.byteLength(part.text)>256*1024)invalidRecord('Invalid file API text part');
  }
  result.parts=[...apiParts,...result.parts];
  if(result.parts.length>20000)invalidRecord('File part count exceeds limit');
  if(result.parts.reduce((bytes,part)=>bytes+Buffer.byteLength(part.text),0)>16*1024*1024)invalidRecord('File text exceeds limit');
  fileVersion=digest([data.content_sha256||'',data.media_type,'document-text-v1',result.parts.map(p=>[p.path,digest(p.text)])]);
 }
 const make=(kind: string,sourceId: string,extra: {text: string; [field: string]: unknown}): DocumentItem=>{const document: ConnectorDocument={...common,kind,sourceId,resourceVersion:fileVersion,...extra};document.contentHash=digest({...document,sourceKey:undefined});return {id:documentId(binding,kind,sourceId),document};};
 const chunks=[];
 for(const part of result.parts){for(const chunk of textChunks(part.text)){chunks.push(make('file_chunk',sourceId+':'+fileVersion+':'+chunks.length,{parentId:sourceId,parentKind:'file',text:chunk.text,partPath:part.path,partStart:chunk.start,partEnd:chunk.end,partOverlap:chunk.overlap}));}}
 const metadataText=[label(data.title),label(data.name),label(data.preview)].filter(Boolean).join('\n');
 if(Buffer.byteLength(metadataText)>256*1024)invalidRecord('File metadata text exceeds limit');
 const manifest=make('file',sourceId,{text:metadataText,available:data.available,chunkCount:chunks.length,extractionStatus:result.status});
 return {chunks,manifest,extraction:{status:result.status,sourceSha256:data.content_sha256,parts:result.parts.length,pages:result.pages}};
}
