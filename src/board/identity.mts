import {createHash} from 'node:crypto';
import type {BoardMessage, BoardState} from './types.mjs';

export const boardIdentity = (userId: string, handle: string) => createHash('sha256').update(JSON.stringify([userId, handle])).digest('hex');

/** A name can select a registered session only after its account owner is known. */
export function resolveBoardIdentity(state: BoardState, userId: string, name: string) {
  const registered = Object.entries(state.participants || {}).find(([, p]) =>
    p.userId === userId && p.name.toLowerCase() === name.toLowerCase());
  return registered ? {id: registered[0], name: registered[1].name} : {id: boardIdentity(userId, name), name};
}

/** Keep retries of pre-registration/name-derived posts stable after convergence. */
export function findBoardPublication(state: BoardState, userId: string, id: string, name: string, requestId: string) {
  const exact = state.messages.find(m => m.author === userId && m.agent === id && m.requestId === requestId);
  if (exact || state.participants?.[id]?.userId !== userId) return exact;
  return state.messages.find(m => m.author === userId && m.requestId === requestId
    && m.name.toLowerCase() === name.toLowerCase() && m.agent === boardIdentity(userId, m.name));
}

/** Recognize the account-bound MCP alias without rewriting historical IDs or receipts. */
export function ownBoardMessage(message: BoardMessage, userId: string, id: string, name: string, state: BoardState) {
  if (message.author !== userId) return false;
  if (message.agent === id) return true;
  if (message.name.toLowerCase() !== name.toLowerCase()) return false;
  return message.agent === boardIdentity(userId, message.name)
    || state.participants?.[message.agent]?.name.toLowerCase() === name.toLowerCase();
}
