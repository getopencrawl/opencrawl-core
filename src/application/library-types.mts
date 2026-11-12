/** Wire contract for the session and memory library. Runtime adapters send each
 * operation to the core library API; the server owns scope and permissions. */
export type LibraryScope = 'all' | 'mine';
export type Visibility = 'team' | 'private';
/** Agents with native memory files. Sessions are captured from more agents. */
export type Harness = 'claude-code' | 'codex';
export type SessionHarness = Harness | 'grok-bot' | 'opencode' | 'cursor' | 'muse';
export interface SessionRef {userId: string; harness: SessionHarness; sessionId: string}
/** Capture-machine names, not a verified original execution host. Optional for older adapters. */
export interface SessionHosts {host?: string | null; hosts?: string[]; hostsTruncated?: boolean}
export interface SessionSummary extends SessionRef, SessionHosts {
  title: string; private: boolean; mine: boolean; origin: string | null; host: string | null;
  firstActivityAt: string | null; lastActivityAt: string | null; events: number;
}
export type TranscriptEntry =
  | {type: 'message'; role: 'user' | 'assistant'; text: string}
  | {type: 'tool_call'; name: string; input: string; truncated: boolean}
  | {type: 'tool_result'; text: string; truncated: boolean}
  | {type: 'note'; label: string; text: string; truncated: boolean};
export interface TranscriptEvent {eventId: string; kind: string; timestamp: string | null; entries: TranscriptEntry[]}
export interface SessionTranscript {
  session: SessionRef & SessionHosts & {title: string; mine: boolean; private: boolean; origin: string | null};
  events: TranscriptEvent[]; total: number; next: string | null;
}
export interface MemoryRef {userId: string; harness: Harness; path: string}
export interface MemorySummary extends MemoryRef {
  title: string; project: string; description: string; modifiedAt: string | null; private: boolean; mine: boolean; host: string | null; sourceSessionId: string | null;
}
export interface MemoryDocument {memory: Omit<MemorySummary, 'description'>; text: string}
/** Display names a hosting adapter may attach. They grant no authority. */
export interface Authors {authors?: Record<string, string>}

export interface LibraryContract {
  'sessions/list': {input: {scope: LibraryScope; query?: string; limit?: number}; output: {sessions: SessionSummary[]; limit: number} & Authors};
  'sessions/read': {input: SessionRef & {cursor?: string | null; limit?: number}; output: SessionTranscript & Authors};
  'sessions/visibility': {input: {harness: SessionHarness; sessionId: string; visibility: Visibility}; output: {visibility: Visibility}};
  'sessions/delete': {input: {harness: SessionHarness; sessionId: string}; output: {deleted: boolean; pending?: boolean}};
  'memories/list': {input: {scope: LibraryScope}; output: {memories: MemorySummary[]; truncated: boolean} & Authors};
  'memories/read': {input: MemoryRef; output: MemoryDocument & Authors};
  'memories/visibility': {input: {harness: Harness; path: string; visibility: Visibility}; output: {visibility: Visibility}};
  'memories/delete': {input: {harness: Harness; path: string}; output: {deleted: true}};
}
export type LibraryOperation = keyof LibraryContract;
export type LibraryAdapter = <O extends LibraryOperation>(operation: O, input: LibraryContract[O]['input'], signal: AbortSignal) => Promise<LibraryContract[O]['output']>;
