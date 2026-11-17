import type {ConnectorBinding, ConnectorStore} from './types.mjs';
interface Catalog {scope: string; channels: string[]}
interface FileCatalog extends Catalog {files: Record<string, string[]>}
import {digest, invalidRecord, validateBinding} from './scope.mjs';

const MAX_BYTES=16*1024*1024, MAX_IDENTITIES=100000;
const validId=(value: unknown): value is string=>typeof value==='string'&&/^[A-Z][A-Z0-9]{1,100}$/.test(value);
function ids(values: unknown): string[] {
 if(!Array.isArray(values)||values.length>MAX_IDENTITIES||values.some(value=>!validId(value)))invalidRecord('Invalid Slack catalog identities');
 return values as string[];
}

/** Seed access-reconciliation identities from operator-trusted indexed or raw
 * source metadata. This grants no access, deletes nothing, and is retryable.
 * Serialize with capture: its multi-object catalogs are not a global CAS lock.
 */
export async function seedSlackSourceCatalog({binding,store,channelIds=[],fileShares=[],checkActive=async()=>{}}: {binding: ConnectorBinding; store: ConnectorStore; channelIds?: string[]; fileShares?: {fileId: string; channelId: string}[]; checkActive?: (binding: ConnectorBinding)=>Promise<unknown>}) {
 validateBinding(binding);
 if(binding.provider!=='slack'||!store?.get||!store?.put)invalidRecord('Slack catalog binding and store required');
 ids(channelIds);
 if(!Array.isArray(fileShares)||fileShares.length>MAX_IDENTITIES||fileShares.some(share=>!validId(share?.fileId)||!validId(share?.channelId)))invalidRecord('Invalid Slack catalog shares');
 const scope=digest(binding),fileKey=binding.rawPrefix+'capture/files-v1/catalog.json',messageKey=binding.rawPrefix+'capture/messages-v1/catalog.json';
 await checkActive(binding);
 async function read<T extends Catalog>(key: string,fallback: T): Promise<T> {
  const bytes=await store.get(key,{maxBytes:MAX_BYTES});
  if(!bytes)return fallback;
  if(bytes.length>MAX_BYTES)invalidRecord('Slack catalog exceeds limit');
  const catalog=JSON.parse(bytes.toString()) as T;
  if(catalog?.scope!==scope)invalidRecord('Slack catalog scope mismatch');
  ids(catalog.channels);return catalog;
 }
 const fileCatalog=await read<FileCatalog>(fileKey,{scope,channels:[],files:{}});
 const messageCatalog=await read(messageKey,{scope,channels:[]});
 if(!fileCatalog.files||typeof fileCatalog.files!=='object'||Array.isArray(fileCatalog.files))invalidRecord('Invalid Slack catalog files');
 const channels=new Set([...channelIds,...fileCatalog.channels,...messageCatalog.channels]),files=new Map<string, Set<string>>();
 for(const [fileId,shares] of Object.entries(fileCatalog.files)) {
  if(!validId(fileId))invalidRecord('Invalid Slack catalog file identity');
  files.set(fileId,new Set(ids(shares)));
  for(const channelId of shares)channels.add(channelId);
 }
 for(const {fileId,channelId} of fileShares) {
  if(!files.has(fileId))files.set(fileId,new Set());
  files.get(fileId)!.add(channelId);channels.add(channelId);
 }
 if(channels.size>MAX_IDENTITIES||files.size>MAX_IDENTITIES)invalidRecord('Slack catalog identity limit exceeded');
 const channelList=[...channels].sort(),fileEntries=[...files].sort(([a],[b])=>a.localeCompare(b)).map(([fileId,shares]): [string, string[]]=>[fileId,[...shares].sort()]);
 const fileBytes=Buffer.from(JSON.stringify({scope,channels:channelList,files:Object.fromEntries(fileEntries)}));
 const messageBytes=Buffer.from(JSON.stringify({scope,channels:channelList}));
 if(fileBytes.length>MAX_BYTES||messageBytes.length>MAX_BYTES)invalidRecord('Slack catalog exceeds limit');
 // Validate both inputs and outputs before the first mutation. If the second
 // write fails, repeating the operation unions with the first committed write.
 await checkActive(binding);await store.put(fileKey,fileBytes,'application/json');
 await checkActive(binding);await store.put(messageKey,messageBytes,'application/json');
 return {messageChannels:channels.size,fileChannels:channels.size,files:files.size,fileShares:fileEntries.reduce((total,[,shares])=>total+shares.length,0)};
}
