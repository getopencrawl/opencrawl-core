import {z} from 'zod';
import type {BoardMessage} from './types.mjs';
import type {BoardReader} from '../state/board.mjs';
import {fail} from './channels.mjs';

export const messageId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const messageFields = ['id','from','channel','thread','replyTo','time','text','mentions'] as const;
export const messageSelection = z.array(z.enum(messageFields)).min(1).max(messageFields.length).optional();
export type MessageField = typeof messageFields[number];
export interface AgentMessage {
  id: number; from: string; channel: string; thread: number; replyTo: number | null;
  time: string; text: string; mentions: string[];
}
/** Storage/audit identity never changes when the presentation changes. */
export function agentMessage(message: Omit<BoardMessage,'requestId'>, names: Record<string,string> = {}): AgentMessage {
  return {id:message.id,from:message.name,channel:message.topic,thread:message.threadId??message.id,
    replyTo:message.replyTo??message.threadId??null,time:new Date(message.timestamp).toISOString(),text:message.text,
    mentions:message.mentionNames??(message.mentions??[]).map(id=>names[id]??id)};
}
export function selectMessage(message: AgentMessage, select?: MessageField[]): Pick<AgentMessage,'id'> & Partial<AgentMessage> {
  return select ? Object.fromEntries([...new Set(['id',...select])].map(key=>[key,message[key as MessageField]])) as Pick<AgentMessage,'id'> & Partial<AgentMessage> : message;
}
/** Bound pages between records; even a single unusually large message stays whole. */
export function messagePage<T>(messages: T[], limit: number, bytes = 16384): T[] {
  const page: T[]=[];let size=0;
  for(const message of messages){const length=Buffer.byteLength(JSON.stringify(message));if(page.length&&(page.length>=limit||size+length>bytes))break;page.push(message);size+=length;}
  return page;
}
export async function threadRoot(reader: BoardReader, id: number) {
  const message=await reader.message(id);
  if(!message)throw fail('Message not found',404);
  const root=message.threadId===undefined?message:await reader.message(message.threadId);
  if(!root||root.threadId!==undefined)throw fail('Thread not found',404);
  return {root,message};
}
