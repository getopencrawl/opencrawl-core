import type {ConnectorBinding,SlackCaptureOptions} from './types.mjs';
import {digest, invalidRecord, validateBinding} from './scope.mjs';

const MAX_IDENTITIES=100000;
const validId=(value: unknown): value is string=>typeof value==='string'&&/^[A-Z][A-Z0-9]{1,100}$/.test(value);
function ids(values: unknown): string[] {
 if(!Array.isArray(values)||values.length>MAX_IDENTITIES||values.some(value=>!validId(value)))invalidRecord('Invalid Slack catalog identities');
 return values as string[];
}

/** Seed access-reconciliation identities from operator-trusted indexed or raw
 * source metadata. This grants no access, deletes nothing, and is retryable.
 * PostgreSQL unions identities with concurrent capture without losing history.
 */
export async function seedSlackSourceCatalog({binding,state,channelIds=[],fileShares=[],checkActive=async()=>{}}: {binding: ConnectorBinding; state:SlackCaptureOptions['state']; channelIds?: string[]; fileShares?: {fileId: string; channelId: string}[]; checkActive?: (binding: ConnectorBinding)=>Promise<unknown>}) {
 validateBinding(binding);
 if(binding.provider!=='slack'||!state?.slackCapture)invalidRecord('Slack catalog binding and PostgreSQL state required');
 ids(channelIds);
 if(!Array.isArray(fileShares)||fileShares.length>MAX_IDENTITIES||fileShares.some(share=>!validId(share?.fileId)||!validId(share?.channelId)))invalidRecord('Invalid Slack catalog shares');
 const scope=digest(binding);
 await checkActive(binding);
 const fileCatalog=await state.slackCapture.readCatalog(binding,'files-v1')??{scope,channels:[],files:{}};
 const messageCatalog=await state.slackCapture.readCatalog(binding,'messages-v1')??{scope,channels:[]};
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
 // Validate both inputs and outputs before the first mutation. If the second
 // write fails, repeating the operation unions with the first committed write.
 await checkActive(binding);await state.slackCapture.mergeCatalog(binding,'files-v1',{scope,channels:channelList,files:Object.fromEntries(fileEntries)});
 await checkActive(binding);await state.slackCapture.mergeCatalog(binding,'messages-v1',{scope,channels:channelList});
 return {messageChannels:channels.size,fileChannels:channels.size,files:files.size,fileShares:fileEntries.reduce((total,[,shares])=>total+shares.length,0)};
}
