import {createHash} from 'node:crypto';
import type {BoardMessage, BoardState} from './types.mjs';

export const boardIdentity = (userId: string, handle: string) => createHash('sha256').update(JSON.stringify([userId, handle])).digest('hex');

/** Recognize the account-bound MCP alias without rewriting historical IDs or receipts. */
export function ownBoardMessage(message: BoardMessage, userId: string, id: string, name: string, state: BoardState) {
  if (message.author !== userId) return false;
  if (message.agent === id) return true;
  if (message.name.toLowerCase() !== name.toLowerCase()) return false;
  return message.agent === boardIdentity(userId, message.name)
    || state.participants?.[message.agent]?.name.toLowerCase() === name.toLowerCase();
}
