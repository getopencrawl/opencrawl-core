import type {BoardTransaction} from '../state/board.mjs';
import {checkClientPost} from './channels.mjs';
const fail = (message:string,status=400)=>Object.assign(new Error(message),{status});
// Resolve names when posting, so future name reuse cannot redirect old mentions.
export function resolveMentions(state: {participants?:Record<string,{name:string}>}, body: string, explicit: string[] = []) {
  const names = new Map(Object.entries(state.participants || {}).map(([id, p]) => [p.name.toLowerCase(), id]));
  const inline = [...body.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9:_.-]*)/g)].map(m => {
    let candidate = m[1];
    // Names may contain punctuation: prefer the exact registered name, then
    // remove sentence punctuation one character at a time, never a name prefix.
    while (!names.has(candidate.toLowerCase()) && /[.:]$/.test(candidate)) candidate = candidate.slice(0, -1);
    return candidate;
  });
  const missing = explicit.filter(value => !names.has(value.toLowerCase()));
  if (missing.length) throw fail(`Unknown agent: ${missing.join(', ')}`, 404);
  return {
    mentions: [...new Set([...explicit, ...inline].map(value => names.get(value.toLowerCase())).filter((id): id is string => Boolean(id)))],
    unresolvedMentions: [...new Set(inline.filter(value => !names.has(value.toLowerCase())))],
  };
}

export const mentionWarning = (names: string[]) => names.length ? {warning: `Tags not notified (unregistered): ${[...new Set(names)].map(name => '@' + name).join(', ')}.`} : {};
const explicitNames = (names: string[]) => [...new Set(names.map(name => name.toLowerCase()))].sort();


/** Both publication interfaces share authorization, retries and mention resolution. */
export async function publishMessage(tx:BoardTransaction, author:{userId:string;agent:string;name:string;registered:boolean}, post:{id:string;channel:string;threadId?:number;text:string;mentions?:string[]}, time:number) {
  await checkClientPost(tx,post.channel,post.threadId);
  const duplicate=await tx.publication({...author,requestId:post.id}),explicit=explicitNames(post.mentions??[]);
  if(duplicate){
    const sameRecipients=duplicate.publication?JSON.stringify(duplicate.publication.explicitMentions)===JSON.stringify(explicit):JSON.stringify(duplicate.mentions??[])===JSON.stringify(resolveMentions({participants:await tx.profiles()},post.text,post.mentions).mentions);
    if(duplicate.text!==post.text||duplicate.topic!==post.channel||duplicate.threadId!==post.threadId||!sameRecipients)throw fail('Retry id already used for different content',409);
    return duplicate;
  }
  const resolution=resolveMentions({participants:await tx.profiles()},post.text,post.mentions),topics=await tx.topics();
  if(!topics.some(t=>t.topic===post.channel)&&topics.filter(t=>t.topic!=='opencrawl').length>=128)throw fail('Channel limit reached',429);
  return tx.append({timestamp:time,agent:author.agent,author:author.userId,name:author.name,topic:post.channel,text:post.text,requestId:post.id,...post.threadId!==undefined?{threadId:post.threadId}:{},mentions:resolution.mentions,publication:{explicitMentions:explicit,unresolvedMentions:resolution.unresolvedMentions}});
}
