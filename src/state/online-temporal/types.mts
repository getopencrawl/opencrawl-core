export interface OnlineMigrationBinding {epoch:string;sourceId:string;targetId:string;shards:number}
export interface OnlineMigrationReference {bindingId:string;shard:number}
export type OnlineMigrationPhase='backfill'|'replay'|'parity'|'caught-up';
export interface OnlineMigrationProgress {phase:OnlineMigrationPhase|'waiting';revision:number;waiting:boolean;parityObserved:boolean}
export interface OnlineMigrationCheckpoint extends OnlineMigrationProgress {phase:OnlineMigrationPhase;cursor:string|null;through:string|null;replayed:string;pendingCursor:string|null;pendingSampleCount:number}
export interface OnlineMigrationPage {cursor:string|null;processed:number}
/** Constructed from trusted operator configuration, never from Workflow input.
 * Each backfill source read AND target apply must run inside the journal's key
 * gate. Keys with mutation history belong exclusively to journal replay.
 * Replay applies only committed entries through the closed contiguous frontier.
 * Parity observes this same epoch/target/frontier; it does not authorize cutover. */
export interface OnlineMigrationAdapter {
 assertCurrent(signal:AbortSignal):Promise<void>;
 reconcilePending(input:{cursor:string|null;limit:number;signal:AbortSignal}):Promise<{cursor:string|null;processed:number;pending:number;settled:number;budgetExhausted:boolean}>;
 frontierState(signal:AbortSignal):Promise<{allocated:string;closed:string;pending:boolean}>;
 backfillPage(input:{shard:number;shards:number;cursor:string|null;limit:number;signal:AbortSignal}):Promise<OnlineMigrationPage>;
 closedFrontier(signal:AbortSignal):Promise<string>;
 replayPage(input:{consumer:string;shard:number;shards:number;through:string;limit:number;signal:AbortSignal}):Promise<{checkpoint:string;processed:number;blocked:boolean}>;
 parityPage(input:{shard:number;shards:number;cursor:string|null;through:string;limit:number;signal:AbortSignal}):Promise<OnlineMigrationPage&{mismatches:number;drift?:boolean}>;
}
