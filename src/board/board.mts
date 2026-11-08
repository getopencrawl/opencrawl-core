import type {Principal, ConditionalStore, StoreVersion} from '../sessions/types.mjs';
import {parseJson} from '../sessions/types.mjs';
import type {BoardState, BoardMessage, VisibleMessage} from './types.mjs';
import type {createBoardSearch} from './search.mjs';
import type {createRecentSessions} from '../sessions/recent.mjs';
import {serviceError} from '../sessions/types.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {boardSearchSchema} from './search.mjs';
import {createParticipation, resolveMentions} from './participation.mjs';

const short = (max: number) => z.string().trim().min(1).max(max);
const topic = short(80);
export const syncSchema = z.strictObject({
  workspace: short(200).describe('Workspace returned by board_topics; checked against your authorized scope.'),
  agent: short(80).describe('Stable session name; display only, identity is bound to your account.'),
  topics: z.array(topic).max(8).default([]),
  after: z.number().int().min(0).optional().describe('Previous cursor for this exact topic selection. Omit to start now; 0 to read history.'),
  posts: z.array(z.strictObject({id: short(80), topic, text: short(512)})).max(3).default([])
    .describe('Only changes others can act on. Reuse the same id when retrying.'),
  leave: z.boolean().default(false),
});
export const topicsSchema = z.strictObject({workspace: short(200).optional(), after: z.number().int().min(0).default(0)});
export const boardReadSchema = z.strictObject({topic: topic.optional(), before: z.number().int().positive().optional()});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string, status = 400) => Object.assign(new Error(message), {status});
const fresh = (): BoardState => ({schema: 1, messages: [], agents: {}, usage: {calls: 0, inputBytes: 0, outputBytes: 0}});
const ttl = 15 * 60 * 1000;

/** One bounded, conditionally replaced document per trusted tenant. No implicit scope. */
export function createBoard({store, prefix, now = Date.now, search, recentSessions, sessionTimeoutMs = 15000}: {store: ConditionalStore; prefix: string; now?: () => number; search?: ReturnType<typeof createBoardSearch>; recentSessions?: ReturnType<typeof createRecentSessions>; sessionTimeoutMs?: number}) {
  if (!store?.readVersion || !store?.compareAndSet || !prefix || /(^|\/)\.\.(\/|$)/.test(prefix)) throw new Error('Board requires a conditional store and prefix');
  if (!Number.isInteger(sessionTimeoutMs) || sessionTimeoutMs < 1 || sessionTimeoutMs > 30000) throw new Error('Invalid session snapshot timeout');
  function scope(principal: Principal) {
    if (!principal || principal.captureAccess !== undefined || typeof principal.tenantId !== 'string' || !principal.tenantId || typeof principal.userId !== 'string' || !principal.userId) throw fail('Board scope required', 403);
    return `${prefix}/tenants/${hash(principal.tenantId)}.json`;
  }
  async function read(key: string) {
    const object = await store.readVersion(key, {maxBytes: 16 * 1024 * 1024});
    const state = object.data ? parseJson<BoardState>(object.data) : fresh();
    if (state.schema !== 1) throw fail('Unsupported board version', 503);
    return {...object, state};
  }
  async function commit(key: string, version: StoreVersion | null, state: BoardState) {
    const encoded = Buffer.from(JSON.stringify(state));
    if (encoded.length > 16 * 1024 * 1024) throw fail('Board pilot storage limit reached; preserve history before starting a new board', 429);
    return store.compareAndSet(key, version, encoded);
  }
  return {
    participate: createParticipation({scope, read, commit, now}),
    /** Browse the durable log without writing presence, usage or search indexes. */
    async read(principal: Principal, input: unknown = {}) {
      const key = scope(principal), args = boardReadSchema.parse(input);
      const {state} = await read(key);
      const summaries = new Map<string, {topic: string; posts: number; latest: {id: number; timestamp: number; name: string}}>();
      for (const message of state.messages) {
        const summary = summaries.get(message.topic) || {topic: message.topic, posts: 0, latest: {id: message.id, timestamp: message.timestamp, name: message.name || message.agent}};
        summary.posts++;
        summary.latest = {id: message.id, timestamp: message.timestamp, name: message.name || message.agent};
        summaries.set(message.topic, summary);
      }
      const messages: VisibleMessage[] = [];
      let more = false;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = state.messages[i];
        if ((args.before !== undefined && message.id >= args.before) || (args.topic && message.topic !== args.topic)) continue;
        if (messages.length === 20) {more = true; break;}
        const {requestId, ...visible} = message;
        messages.push(visible);
      }
      return {topics: [...summaries.keys()].sort(),
        topicSummaries: [...summaries.values()].sort((a, b) => b.latest.id - a.latest.id), messages,
        next: more ? messages.at(-1)!.id : null};
    },
    ...(search ? {async search(principal: Principal, input: unknown) {
      const key = scope(principal), args = boardSearchSchema.parse(input);
      if (args.workspace !== principal.tenantId) throw fail('Workspace scope mismatch', 403);
      const {state} = await read(key);
      return search.search(principal, state.messages, key, args);
    }} : {}),
    async topics(principal: Principal, input: unknown = {}) {
      const {after, workspace} = topicsSchema.parse(input);
      scope(principal);
      if (workspace !== undefined && workspace !== principal.tenantId) throw fail('Workspace scope mismatch', 403);
      const {state} = await read(scope(principal));
      const names = [...new Set(state.messages.map(m => m.topic))];
      const time = now();
      const topics = []; let bytes = 0;
      for (const name of names.slice(after, after + 12)) {
        const item = {
        topic: name,
        latest: state.messages.findLast(m => m.topic === name)?.id,
        active: Object.entries(state.agents).filter(([, a]) => a.seen > time - ttl && a.topics.includes(name))
          .slice(0, 4).map(([id, a]) => ({id, name: a.name, seen: a.seen})),
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (topics.length && bytes + size > 4096) break;
        topics.push(item); bytes += size;
      }
      return {workspace: principal.tenantId, topics, next: after + topics.length < names.length ? after + topics.length : null};
    },
    async sync(principal: Principal, input: unknown) {
      const key = scope(principal), args = syncSchema.parse(input);
      if (args.workspace !== principal.tenantId) throw fail('Workspace scope mismatch', 403);
      const agentId = hash(JSON.stringify([principal.userId, args.agent]));
      const requestBytes = Buffer.byteLength(JSON.stringify(input));
      let sessions: Awaited<ReturnType<ReturnType<typeof createRecentSessions>['read']>> = [], sessionState = recentSessions ? 'ready' : 'not_configured';
      if (recentSessions) {
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        try { sessions = await Promise.race([recentSessions.read(principal, {signal: controller.signal}),
          new Promise<never>((_, reject) => {timer = setTimeout(() => {controller.abort(); reject(new Error('Session snapshot timeout'));}, sessionTimeoutMs);})]); }
        catch(caught){const error=serviceError(caught);
          if (error.status === 403 || error.status === 401) throw error;
          sessionState = 'unavailable';
        } finally {clearTimeout(timer);}
      }
      let start = args.after;
      for (let attempt = 0; attempt < 8; attempt++) {
        const {state, version} = await read(key), time = now();
        // Starting "now" is anchored to the first read. A CAS retry must still
        // deliver messages that arrived while this call was trying to commit.
        start ??= state.messages.length;
        if (start > state.messages.length) throw fail('Cursor exceeds board history');
        // Presence is a recent observation, never proof that an agent is still alive.
        for (const [id, a] of Object.entries(state.agents)) if (a.seen <= time - ttl) delete state.agents[id];
        if (args.leave) delete state.agents[agentId];
        else {
          if (!state.agents[agentId] && Object.keys(state.agents).length >= 128) throw fail('Active agent limit reached', 429);
          state.agents[agentId] = {name: args.agent, topics: args.topics, seen: time};
        }
        const accepted = [];
        for (const post of args.posts) {
          if (Buffer.byteLength(post.text) > 1024) throw fail('Message exceeds 1024 UTF-8 bytes');
          const duplicate = state.messages.find(m => m.agent === agentId && m.requestId === post.id);
          if (duplicate) {
            if (duplicate.topic !== post.topic || duplicate.text !== post.text) throw fail('Retry id already used for different content', 409);
            accepted.push(duplicate.id); continue;
          }
          if (!state.messages.some(m => m.topic === post.topic) && new Set(state.messages.map(m => m.topic)).size >= 128) throw fail('Topic limit reached', 429);
          const message: BoardMessage = {id: state.messages.length + 1, timestamp: time, agent: agentId, author: principal.userId, name: args.agent,
            topic: post.topic, text: post.text, requestId: post.id};
          const mentions = resolveMentions(state, post.text);
          if (mentions.length) message.mentions = mentions;
          state.messages.push(message); accepted.push(message.id);
        }
        const messages: VisibleMessage[] = []; let cursor = start, bytes = 0;
        for (const m of state.messages.slice(start)) {
          if (args.topics.includes(m.topic) && m.agent !== agentId) {
            const {requestId, ...message} = m;
            const size = Buffer.byteLength(JSON.stringify(message));
            if (messages.length >= 5 || bytes + size > 4096) break;
            messages.push(message); bytes += size;
          }
          cursor = m.id;
        }
        const output = {agent: agentId, cursor, more: cursor < state.messages.length, accepted, messages,
          recentSessions: sessions, recentSessionsStatus: {state: sessionState, limit: 10, order: 'lastActivityAt_desc', source: 'indexed_capture'}};
        state.usage.calls++;
        state.usage.inputBytes += requestBytes;
        state.usage.outputBytes += Buffer.byteLength(JSON.stringify(output));
        const encoded = Buffer.from(JSON.stringify(state));
        if (encoded.length > 16 * 1024 * 1024) throw fail('Board pilot storage limit reached; preserve history before starting a new board', 429);
        if (await store.compareAndSet(key, version, encoded)) return output;
      }
      throw fail('Board busy; retry at your next work boundary with the same post ids', 503);
    },
  };
}
