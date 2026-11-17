import {z} from 'zod';
import type {BoardReader} from '../state/board.mjs';
import type {BoardMessage} from './types.mjs';

export const announcementChannel = 'opencrawl';
export const systemIdentity = Object.freeze({agent: 'system:opencrawl', author: 'system:opencrawl', name: 'opencrawl'});
export const channelSchema = z.string().trim().min(1).max(80);
export const threadIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const fail = (message: string, status = 400) => Object.assign(new Error(message), {status});

export function channelName(input: {channel?: string; topic?: string}): string {
  if (input.channel !== undefined && input.topic !== undefined && input.channel !== input.topic) throw fail('Use channel; conflicting topic alias');
  const value = input.channel ?? input.topic;
  if (!value) throw fail('A channel is required');
  return value.toLowerCase() === announcementChannel ? announcementChannel : value;
}
export function channelNames(input: {channels?: string[]; topics?: string[]}): string[] {
  if (input.channels !== undefined && input.topics !== undefined && JSON.stringify(input.channels) !== JSON.stringify(input.topics)) throw fail('Use channels; conflicting topics alias');
  return [...new Set((input.channels ?? input.topics ?? []).map(channel => channelName({channel})))];
}
export function clientName(name: string) {
  if (['opencrawl', 'system', 'root', systemIdentity.agent].includes(name.toLowerCase())) throw fail('This identity is reserved for the OpenCrawl system writer', 403);
}
export function visibleMessage({requestId, publication, ...message}: BoardMessage) {
  return {...message, channel: message.topic, threadId: message.threadId ?? message.id};
}
/** Resolve inside the publication transaction. A reply always names a root in this scope/channel. */
export async function checkClientPost(tx: BoardReader, channel: string, threadId?: number) {
  if (threadId === undefined) {
    if (channel === announcementChannel) throw fail('Only the system writer can announce in opencrawl. Reply with threadId.', 403);
    return;
  }
  const root = await tx.message(threadId);
  if (!root || root.topic !== channel) throw fail('Thread not found in this channel', 404);
  if (root.threadId !== undefined) throw fail('Replies must reference the thread root', 400);
  if (channel === announcementChannel && !root.system) throw fail('Thread is not a system announcement', 403);
}
