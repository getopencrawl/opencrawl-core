import {createHash} from 'node:crypto';
import {z} from 'zod';

const short = (max) => z.string().trim().min(1).max(max);
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
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const fresh = () => ({schema: 1, messages: [], agents: {}, usage: {calls: 0, inputBytes: 0, outputBytes: 0}});
const ttl = 15 * 60 * 1000;

/** One bounded, conditionally replaced document per trusted tenant. No implicit scope. */
export function createBoard({store, prefix, now = Date.now}) {
  if (!store?.readVersion || !store?.compareAndSet || !prefix || /(^|\/)\.\.(\/|$)/.test(prefix)) throw new Error('Board requires a conditional store and prefix');
  function scope(principal) {
    if (!principal || typeof principal.tenantId !== 'string' || !principal.tenantId || typeof principal.userId !== 'string' || !principal.userId) throw fail('Board scope required', 403);
    return `${prefix}/tenants/${hash(principal.tenantId)}.json`;
  }
  async function read(key) {
    const object = await store.readVersion(key, {maxBytes: 16 * 1024 * 1024});
    const state = object.data ? JSON.parse(object.data) : fresh();
    if (state.schema !== 1) throw fail('Unsupported board version', 503);
    return {...object, state};
  }
  return {
    async topics(principal, input = {}) {
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
    async sync(principal, input) {
      const key = scope(principal), args = syncSchema.parse(input);
      if (args.workspace !== principal.tenantId) throw fail('Workspace scope mismatch', 403);
      const agentId = hash(JSON.stringify([principal.userId, args.agent]));
      const requestBytes = Buffer.byteLength(JSON.stringify(input));
      for (let attempt = 0; attempt < 8; attempt++) {
        const {state, version} = await read(key), time = now();
        const start = args.after ?? state.messages.length;
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
          if (state.messages.length >= 10000) throw fail('Board pilot capacity reached; export before starting a new board', 429);
          if (!state.messages.some(m => m.topic === post.topic) && new Set(state.messages.map(m => m.topic)).size >= 128) throw fail('Topic limit reached', 429);
          const message = {id: state.messages.length + 1, timestamp: time, agent: agentId, author: principal.userId, name: args.agent,
            topic: post.topic, text: post.text, requestId: post.id};
          state.messages.push(message); accepted.push(message.id);
        }
        const messages = []; let cursor = start, bytes = 0;
        for (const m of state.messages.slice(start)) {
          if (args.topics.includes(m.topic) && m.agent !== agentId) {
            const {requestId, ...message} = m;
            const size = Buffer.byteLength(JSON.stringify(message));
            if (messages.length >= 5 || bytes + size > 4096) break;
            messages.push(message); bytes += size;
          }
          cursor = m.id;
        }
        const output = {agent: agentId, cursor, more: cursor < state.messages.length, accepted, messages};
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
