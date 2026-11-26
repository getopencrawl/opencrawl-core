export interface DailyOverlap {date: string; average: number; peak: number; partial: boolean}
export interface SessionOverlap {timeZone: 'UTC'; measuredAt: string; sessions: number; daily: DailyOverlap[]}
export interface NamedCount {name: string; count: number}
export type UsageSource = 'organization' | 'members' | 'integrations' | 'sessions' | 'overlap' | 'connectors' | 'capture' | 'onboarding';
export type UsageSection = 'workspace' | 'agents' | 'overlap' | 'ingestion' | 'members' | 'capture';
interface UsageReportBase {
  workspace: string | null;
  team?: boolean;
  /** null: every captured day. */
  days: number | null;
  generatedAt: string;
  /** Failed reads are distinct from an unconfigured service or a measured zero. */
  failedSources?: UsageSource[];
  /** Client-retained measurements keep their original freshness timestamp. */
  staleSections?: Partial<Record<UsageSection, string>>;
  ingestion: null | {
    sources: Array<{name: string; icon: string; account?: string | null; state: string; records: number | null; indexed: number | null; indexedSpecies?: NamedCount[]; lastSyncedAt: string | null; connectedBy?: string | null; units?: [string, string]; rows?: Array<{label: string; count: number}>}>;
    index: null | {sessionEvents: number | null; connectorDocuments: number | null; sources: NamedCount[]; searchMs: number | null; probes?: number[]};
  };
  /** Agent-session tokens captured this billing period, when the deployment meters them. */
  capture?: {tokens: number; since: string} | null;
  members: Array<{userId?: string; name: string | null; email: string; you: boolean; sources: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; weekEvents: number; lastAt: string | null; setup: {shared?: {name: string; observedAt: string}; cli?: unknown; mcp?: unknown; session?: unknown; client?: string | null}}>;
}
interface AgentUsage {
  events: number; lifetimeEvents: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; machines: number; opencrawlCalls: number;
  people?: Array<{userId: string}>;
  tools: NamedCount[]; harnesses: NamedCount[]; origins: NamedCount[];
  firstAt: string | null; lastAt: string | null;
  daily: Array<{date: string; events: number; sessions: number}>;
}
/** Independent measurements can fail without discarding the rest of the report. */
export type UsageReport = UsageReportBase & {agents: AgentUsage | null; overlap: SessionOverlap | null};
type UsageMetadata = Pick<UsageReport, 'days' | 'generatedAt' | 'failedSources' | 'staleSections'>;
export type UsageHighlights = UsageMetadata & Pick<UsageReport, 'workspace' | 'capture'>;
export type UsageDetails = Omit<UsageReport, 'workspace' | 'capture'>;
export interface DiagnosticHit {_id?: string; _score?: number; _source?: Record<string, unknown>}
export interface SearchResponse {
  state?: string; truncated?: boolean; timed_out?: boolean; _shards?: {failed?: number};
  hits?: {total?: {value: number; relation?: 'eq' | 'gte'}; hits?: DiagnosticHit[]};
}
export interface DiagnosticSearch {
  page?: {number: number; hasNext: boolean; windowLimited?: boolean};
  partial?: boolean; truncated?: boolean;
  sessions?: Array<{scope: string; response: SearchResponse}>;
  connectors?: {state?: string; truncated?: boolean; responses?: SearchResponse[]};
  memories?: SearchResponse & {truncated?: boolean};
  board?: SearchResponse;
}
export interface BoardMessage {id: number; timestamp: number; name: string; agent: string; topic: string; text: string; channel?: string; threadId?: number; system?: true; replyCount?:number; replyNames?:string[]}
export interface BoardReport {
  messages: BoardMessage[];
  threadRoot?: BoardMessage;
  searchPage?: {total:number; cursor:string|null};
  channels?: string[];
  channelSummaries?: Array<{channel:string;readOnly:boolean;posts:number;latest:{timestamp:number;name:string}}>;
  topicSummaries: Array<{topic: string; posts: number; latest: {timestamp: number; name: string}}>;
  next: number | null;
}
export interface ConsoleDataAdapter {
  callTotals?(range:import('./usage-range.mjs').UsageRange,signal:AbortSignal,basis?:'events'):Promise<import('./search-activity.mjs').CallTotals & {cacheScope:string}>;
  usageTokens?(range:import('./usage-range.mjs').UsageRange,signal:AbortSignal,basis?:'session-start'):Promise<import('./usage-range.mjs').TokenUsage & {cacheScope:string}>;
  tokenSessions?(input:import('./usage-range.mjs').TokenSessionsRequest,signal:AbortSignal):Promise<import('./usage-range.mjs').TokenSessionPage & {cacheScope:string}>;
  searchHistory?(input:import('./search-activity.mjs').HistoryRequest & {basis?:'events'},signal:AbortSignal):Promise<import('./search-activity.mjs').SearchActivityPage & {cacheScope:string}>;
  usageHighlights?(signal: AbortSignal): Promise<UsageHighlights & {cacheScope: string}>;
  usageDetails?(signal: AbortSignal, range?: import('./usage-range.mjs').UsageRange): Promise<UsageDetails & {cacheScope: string}>;
  usage(signal: AbortSignal): Promise<UsageReport>;
  search(query: string, signal: AbortSignal, page?: number): Promise<DiagnosticSearch>;
  boardDestination?(path:string,signal:AbortSignal):Promise<import('./board-links.mjs').BoardDestination>;
  board(input: {workspaceKey?:string; query?:string; cursor?:string; channel?:string; topic?: string; threadId?:number; rootsOnly?:boolean; before?: number}, signal: AbortSignal): Promise<BoardReport>;
}
