export interface DailyOverlap {date: string; average: number; peak: number; partial: boolean}
export interface SessionOverlap {timeZone: 'UTC'; measuredAt: string; sessions: number; daily: DailyOverlap[]}
export interface NamedCount {name: string; count: number}
/** Per-million-token list prices for one model, as of a stated date. */
export interface ModelPrice {model: string; input: number; cacheRead: number; cacheWrite: number; output: number; asOf: string}
/**
 * How OpenCrawl kept one workspace's agents aligned (schema 4), measured from work captured
 * live since it installed OpenCrawl. Every number counts something that happened; nothing
 * estimates what agents would have done otherwise, and no token or dollar saving is claimed.
 */
export interface ValueReport {
  schema: 4;
  measuredAt: string;
  /** From the first live capture to the last day measured. */
  window: {from: string; to: string; days: number};
  /** The model the workspace's agents use most, priced at its list price. */
  model: ModelPrice & {share: number};
  work: {sessions: number; tasks: number};
  /** Model tokens the agents processed in captured sessions, by type. */
  spend: {input: number; cacheRead: number; cacheWrite: number; output: number};
  /** Times a message from another agent made an agent change course. */
  drift: {conflictsAvoided: number; duplicatesAvoided: number};
  /** Searches agents ran for real work, and board messages that reached an agent. */
  usage: {searches: number; boardMessages: number};
  /** Search results agents went on to use and fixes they picked up from the board, with what the searches found. */
  value: {searchesUsed: number; fixesReused: number; found: {teammateWork: number; whereThingsLive: number; pastDecisions: number; pastFixes: number; other: number}};
}
interface UsageReportBase {
  workspace: string | null;
  team?: boolean;
  days: number;
  generatedAt: string;
  ingestion: null | {
    sources: Array<{name: string; icon: string; account?: string; state: string; records: number | null; indexed: number | null; indexedSpecies?: NamedCount[]; lastSyncedAt: string | null; connectedBy?: string; units?: [string, string]; rows?: Array<{label: string; count: number}>}>;
    index: null | {sessionEvents: number | null; connectorDocuments: number | null; sources: NamedCount[]; searchMs: number | null; probes?: number[]};
  };
  /** Measured value; absent until the workspace has been measured. */
  value?: ValueReport | null;
  /** Agent-session tokens captured this billing period, when the deployment meters them. */
  capture?: {tokens: number; since: string} | null;
  members: Array<{name: string | null; email: string; you: boolean; sources: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; weekEvents: number; lastAt: string | null; setup: {cli?: unknown; mcp?: unknown; session?: unknown; client?: string | null}}>;
}
interface AgentUsage {
  events: number; lifetimeEvents: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; machines: number; opencrawlCalls: number;
  people?: Array<{userId: string}>;
  tools: NamedCount[]; harnesses: NamedCount[]; origins: NamedCount[];
  firstAt: string | null; lastAt: string | null;
  daily: Array<{date: string; events: number; sessions: number}>;
}
/** Session activity always includes overlap. Only an unconfigured session service omits both. */
export type UsageReport = UsageReportBase & (
  | {agents: AgentUsage | null; overlap: SessionOverlap}
  | {agents: null; overlap: null}
);
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
