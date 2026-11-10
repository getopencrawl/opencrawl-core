export interface NamedCount {name: string; count: number}
/** Per-million-token list prices for one model, as of a stated date. */
export interface ModelPrice {model: string; input: number; cacheRead: number; cacheWrite: number; output: number; asOf: string}
/**
 * What OpenCrawl has done for one workspace (schema 3), measured from work captured live
 * since it installed OpenCrawl and never estimated by the UI. Savings count only real uses:
 * a search whose result the agent then used, or a fix or decision reused from the board.
 * Each use is valued at what finding the same thing by digging costs in this workspace's
 * own sessions (the median), minus what the search itself cost.
 */
export interface ValueReport {
  schema: 3;
  measuredAt: string;
  /** From the first live capture to the last day measured. */
  window: {from: string; to: string; days: number};
  /** The model the workspace's agents use most, priced at its list price. */
  model: ModelPrice & {share: number};
  savings: {sessions: number; tasks: number; uses: number; digTokens: number; digTurns: number; tokenPercent: number; turns: number; turnPercent: number;
    tokens: {input: number; cacheRead: number; cacheWrite: number; output: number}};
  observed: {conflictsAvoided: number; duplicatesAvoided: number; knowledgeReused: number;
    searches: number; searchesUseful: number; searchesUsed: number};
}
export interface UsageReport {
  workspace: string | null;
  team?: boolean;
  days: number;
  generatedAt: string;
  ingestion: null | {
    sources: Array<{name: string; icon: string; account?: string; state: string; records: number; indexed: number | null; indexedSpecies?: NamedCount[]; lastSyncedAt: string | null; connectedBy?: string; units?: [string, string]; rows?: Array<{label: string; count: number}>}>;
    index: null | {sessionEvents: number | null; connectorDocuments: number | null; sources: NamedCount[]; searchMs: number | null; probes?: number[]};
  };
  agents: null | {
    events: number; lifetimeEvents: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; machines: number; opencrawlCalls: number;
    people?: Array<{userId: string}>;
    tools: NamedCount[]; harnesses: NamedCount[]; origins: NamedCount[];
    firstAt: string | null; lastAt: string | null;
    daily: Array<{date: string; events: number; sessions: number}>;
  };
  /** Measured value; absent until the workspace has been measured. */
  value?: ValueReport | null;
  /** Agent-session tokens captured this billing period, when the deployment meters them. */
  capture?: {tokens: number; since: string} | null;
  members: Array<{name: string | null; email: string; you: boolean; sources: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; weekEvents: number; lastAt: string | null; setup: {cli?: unknown; mcp?: unknown; session?: unknown; client?: string | null}}>;
}
export interface DiagnosticHit {_id?: string; _score?: number; _source?: Record<string, unknown>}
export interface SearchResponse {
  state?: string; truncated?: boolean; timed_out?: boolean; _shards?: {failed?: number};
  hits?: {total?: {value: number; relation?: 'eq' | 'gte'}; hits?: DiagnosticHit[]};
}
export interface DiagnosticSearch {
  partial?: boolean; truncated?: boolean;
  sessions?: Array<{scope: string; response: SearchResponse}>;
  connectors?: {state?: string; truncated?: boolean; responses?: SearchResponse[]};
  memories?: SearchResponse & {truncated?: boolean};
}
export interface BoardMessage {id: number; timestamp: number; name: string; agent: string; topic: string; text: string}
export interface BoardReport {
  messages: BoardMessage[];
  topicSummaries: Array<{topic: string; posts: number; latest: {timestamp: number; name: string}}>;
  next: number | null;
}
export interface ConsoleDataAdapter {
  usage(signal: AbortSignal): Promise<UsageReport>;
  search(query: string, signal: AbortSignal): Promise<DiagnosticSearch>;
  board(input: {topic?: string; before?: number}, signal: AbortSignal): Promise<BoardReport>;
}
