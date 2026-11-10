export interface NamedCount {name: string; count: number}
/** Per-million-token list prices for one model, as of a stated date. */
export interface ModelPrice {model: string; input: number; cacheRead: number; cacheWrite: number; output: number; asOf: string}
/**
 * Measured value of OpenCrawl for one workspace (schema 2), produced from work captured
 * live since the workspace installed OpenCrawl, never estimated by the UI. `savings`
 * replays search as agents use it today over that work; `observed` counts effects seen
 * in captured transcripts over the same window.
 */
export interface ValueReport {
  schema: 2;
  measuredAt: string;
  /** From the first live capture to the last day measured. */
  window: {from: string; to: string; days: number};
  /** The model the workspace's agents use most, priced at its list price. */
  model: ModelPrice & {share: number};
  savings: {sessions: number; tasks: number; tokenPercent: number; turns: number; turnsPerTask: number; turnPercent: number;
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
