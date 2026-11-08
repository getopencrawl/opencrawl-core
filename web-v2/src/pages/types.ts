export interface NamedCount {name: string; count: number}
export interface UsageReport {
  workspace: string | null;
  team?: boolean;
  days: number;
  generatedAt: string;
  ingestion: null | {
    sources: Array<{name: string; icon: string; account?: string; state: string; records: number; indexed: number | null; indexedSpecies?: NamedCount[]; lastSyncedAt: string | null; connectedBy?: string; units?: [string, string]; rows?: Array<{label: string; count: number}>}>;
    index: null | {sessionEvents: number; connectorDocuments: number; sources: NamedCount[]; searchMs: number | null; probes?: number[]};
  };
  agents: null | {
    events: number; lifetimeEvents: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; machines: number; opencrawlCalls: number;
    people?: Array<{userId: string}>;
    tools: NamedCount[]; harnesses: NamedCount[]; origins: NamedCount[];
    firstAt: string | null; lastAt: string | null;
    daily: Array<{date: string; events: number; sessions: number}>;
  };
  members: Array<{name: string | null; email: string; you: boolean; sources: number; sessions: number; subagentSessions?: number; messages: number; toolCalls: number; weekEvents: number; lastAt: string | null; setup: {cli?: unknown; mcp?: unknown; session?: unknown; client?: string | null}}>;
}
export interface DiagnosticHit {_id?: string; _score?: number; _source?: Record<string, unknown>}
export interface SearchResponse {state?: string; hits?: {total?: {value: number}; hits?: DiagnosticHit[]}}
export interface DiagnosticSearch {
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
