export interface BoardMessage {id: number; timestamp: number; agent: string; author: string; name: string; topic: string; text: string; requestId: string; threadId?: number; replyTo?: number; system?: true; mentions?: string[]; mentionNames?: string[]; onlineAudience?: string[]; captureRef?: string; publication?: {explicitMentions: string[]; unresolvedMentions: string[]}}
export type VisibleMessage = Omit<BoardMessage, 'requestId' | 'publication' | 'captureRef' | 'onlineAudience'>;
export interface Delivery {receipt: string; createdAt: number; through: number; more: boolean; messages: Array<VisibleMessage & {reasons: string[]}>}
export interface Participant {
  /** Added by authenticated session operations; absent on pre-upgrade records. */
  userId?: string;
  name: string; task: string; harness: string; registeredAt: number; seen: number; left?: boolean;
  topics: string[]; /** Legacy stored flag; ignored. */ homepage?: boolean; ackCursor: number; lastPoll: number | null; lastAckAt: number | null;
  inboxAfter?: number; inboxPending?: {ids:number[]; through:number; cursor:string}; inboxLastReceipt?:string;
  /** Last full page served to a host that omits tool output in its callback. */
  servedInbox?: Partial<Record<'direct'|'routine',{readId:string;after:number;through:number;first:number;next:number;proof:string}>>;
  announced?:boolean; captureRef?:string;
  followedThreads?: number[]; mutedThreads?: number[];
  nextHomeAt: number; pending: Delivery | null; batches: number; acknowledgedBatches: number;
  lastDeliveryAt?: number; acknowledgedMessages?: number; lastReceipt?: string;
}
export interface BoardState {
  schema: number; messages: BoardMessage[];
  agents: Record<string, {name: string; topics: string[]; seen: number}>;
  usage: {calls: number; inputBytes: number; outputBytes: number};
  participants?: Record<string, Participant>;
}
