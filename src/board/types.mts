import type {Principal, StoreVersion} from '../sessions/types.mjs';
export interface BoardMessage {id: number; timestamp: number; agent: string; author: string; name: string; topic: string; text: string; requestId: string; mentions?: string[]; publication?: {explicitMentions: string[]; unresolvedMentions: string[]}}
export type VisibleMessage = Omit<BoardMessage, 'requestId' | 'publication'>;
export interface Delivery {receipt: string; createdAt: number; through: number; more: boolean; messages: Array<VisibleMessage & {reasons: string[]}>}
export interface Participant {
  /** Added by authenticated session operations; absent on pre-upgrade records. */
  userId?: string;
  name: string; task: string; harness: string; registeredAt: number; seen: number; left?: boolean;
  topics: string[]; /** Legacy stored flag; ignored. */ homepage?: boolean; ackCursor: number; lastPoll: number | null; lastAckAt: number | null;
  nextHomeAt: number; pending: Delivery | null; batches: number; acknowledgedBatches: number;
  lastDeliveryAt?: number; acknowledgedMessages?: number; lastReceipt?: string;
}
export interface BoardState {
  schema: number; messages: BoardMessage[];
  agents: Record<string, {name: string; topics: string[]; seen: number}>;
  usage: {calls: number; inputBytes: number; outputBytes: number};
  participants?: Record<string, Participant>;
}
export interface ParticipationOptions {
  scope(principal: Principal): string;
  read(key: string): Promise<{version: StoreVersion | null; state: BoardState}>;
  commit(key: string, version: StoreVersion | null, state: BoardState): Promise<boolean>;
  now(): number;
}
