import {createHash} from 'node:crypto';
import type {SearchDocument} from './types.mjs';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string,status=503) => Object.assign(new Error(message),{status,permanent:status===403});
const corpora = new Set(['connector','session','board','memory']);
export function realmIndex(environment: string,tenantId: string,generation='v1') {
  if (!/^[a-z][a-z0-9-]{0,24}$/.test(environment) || !/^v[1-9][0-9]*$/.test(generation) || typeof tenantId!=='string' || !tenantId) throw fail('Invalid realm scope',403);
  return `opencrawl-${environment}-realm-${hash(tenantId)}-${generation}`;
}
export function realmField(corpus: string,field: string) {
  if(!corpora.has(corpus)) throw fail('Invalid corpus',400);
  return ['tenantId','text','title','sourceKey'].includes(field)?field:corpus+'.'+field;
}
export function realmDocument(corpus: string,id: string,document: SearchDocument) {
  if(!corpora.has(corpus)||typeof id!=='string'||!/^[A-Za-z0-9_:-]{1,256}$/.test(id)||typeof document?.tenantId!=='string'||!document.tenantId) throw fail('Document realm scope required',403);
  const {tenantId,text,title,sourceKey,...metadata}=document;
  const raw=document.timestamp;
  let timestamp= typeof raw==='number'?raw:typeof raw==='string'&&/^\d{10}(\.\d+)?$/.test(raw)?Number(raw)*1000:Date.parse(String(raw));
  if(!Number.isFinite(timestamp)) timestamp=Date.parse(document.receivedAt ?? '')||(document.extractedAt ?? NaN);
  const author=document.author??document.authorId??document.userId;
  const source=corpus==='connector'?document.provider:['session','memory'].includes(corpus)?document.harness:'board';
  return {schema:1,tenantId,corpus,id,source,kind:document.kind||'message',
    ...(Number.isFinite(timestamp)?{timestamp:new Date(timestamp).toISOString()}:{}),
    ...(author?{author}:{}),
    ...(text!==undefined?{text}:{}),...(title!==undefined?{title}:{}),...(sourceKey!==undefined?{sourceKey}:{}),[corpus]:metadata};
}
