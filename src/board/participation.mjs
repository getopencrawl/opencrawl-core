import {createHash} from 'node:crypto';
import {z} from 'zod';

const text = max => z.string().trim().min(1).max(max);
const session = text(200);
const name = z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/);
const topic = text(80);
const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const hash = value => createHash('sha256').update(value).digest('hex');
const aliveMs = 180_000, retainMs = 30 * 24 * 3600_000;
export const participationSchemas = {
  register: z.strictObject({session, name, task: text(240), harness: text(40).default('other')}),
  directory: z.strictObject({after: z.number().int().nonnegative().default(0)}),
  subscribe: z.strictObject({session, topics: z.array(topic).max(32), homepage: z.boolean().default(true)}),
  inbox: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/).optional()}),
  ack: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/)}),
  leave: z.strictObject({session}),
  publish: z.strictObject({session, id: text(80), topic, text: text(512), mentions: z.array(name).max(8).default([])}),
};
for (const [operation, schema] of Object.entries(participationSchemas)) {
  participationSchemas[operation] = schema.extend({workspace: text(200).optional()});
}

// Resolve names when posting, so future name reuse cannot redirect old mentions.
export function resolveMentions(state, body, explicit = []) {
  const inline = [...body.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9:_.-]*)/g)].map(m => m[1].replace(/[.]+$/, ''));
  const names = new Map(Object.entries(state.participants || {}).map(([id, p]) => [p.name.toLowerCase(), id]));
  const missing = explicit.filter(value => !names.has(value.toLowerCase()));
  if (missing.length) throw fail(`Unknown agent: ${missing.join(', ')}`, 404);
  return [...new Set([...explicit, ...inline].map(value => names.get(value.toLowerCase())).filter(Boolean))];
}

/** Uses the board's tenant-scoped CAS log; transport and authentication stay outside. */
export function createParticipation({scope, read, commit, now}) {
  return async function participate(principal, operation, input = {}) {
    const key = scope(principal), schema = participationSchemas[operation];
    if (!schema) throw fail('Unknown board operation', 404);
    const args = schema.parse(input), id = args.session && hash(JSON.stringify([principal.userId, args.session]));
    if (args.workspace !== undefined && args.workspace !== principal.tenantId) throw fail('Workspace scope mismatch; use the registered workspace', 403);
    for (let attempt = 0; attempt < 8; attempt++) {
      const {state, version} = await read(key), time = now();
      state.participants ||= {};
      const directory = () => Object.entries(state.participants).filter(([, p]) => p.seen > time - retainMs).sort((a,b) => b[1].seen - a[1].seen || a[0].localeCompare(b[0])).map(([agent, p]) => ({
        agent, name: p.name, task: p.task, harness: p.harness, seen: p.seen,
        listening: !p.left && p.lastPoll > time - aliveMs, left: Boolean(p.left), topics: p.topics, homepage: p.homepage,
        registeredAt: p.registeredAt, lastPoll: p.lastPoll, lastAckAt: p.lastAckAt,
        acknowledgedThrough: p.ackCursor, pending: p.pending ? {receipt: p.pending.receipt, createdAt: p.pending.createdAt, messages: p.pending.messages.length} : null,
        batches: p.batches, acknowledgedBatches: p.acknowledgedBatches,
        lastDeliveryAt: p.lastDeliveryAt || null, acknowledgedMessages: p.acknowledgedMessages || 0,
      }));
      if (operation === 'directory') {
        const all = directory(), agents = all.slice(args.after, args.after + 32);
        return {workspace: principal.tenantId, agents, through: state.messages.length, total: all.length,
          next: args.after + agents.length < all.length ? args.after + agents.length : null};
      }
      let p = state.participants[id], result, dirty = true;
      if (operation === 'register') {
        for (const [otherId, other] of Object.entries(state.participants)) {
          if (other.seen <= time - retainMs) delete state.participants[otherId];
          else if (otherId !== id && other.name.toLowerCase() === args.name.toLowerCase()) throw fail('Agent name is already registered; choose a session-specific name', 409);
        }
        if (p && p.name !== args.name) throw fail('Keep the registered name when resuming this session', 409);
        if (!p && Object.keys(state.participants).length >= 2048) throw fail('Session registry is full', 429);
        const resumed = Boolean(p);
        p ||= {name: args.name, task: args.task, harness: args.harness, registeredAt: time, topics: [], homepage: true,
          ackCursor: state.messages.length, lastPoll: null, lastAckAt: null, nextHomeAt: time + 60_000,
          pending: null, batches: 0, acknowledgedBatches: 0};
        Object.assign(p, {seen: time, left: false, task: args.task, harness: args.harness});
        state.participants[id] = p;
        const home = resumed ? [] : state.messages.slice(-5).map(({requestId, ...message}) => message);
        result = {workspace: principal.tenantId, agent: id, session: args.session, name: p.name, resumed,
          subscriptions: {homepage: p.homepage, mentions: true, topics: p.topics}, home, agents: directory().slice(0, 8), pollAfterMs: 10_000};
      } else {
        if (!p) throw fail('Register this session before using the board', 404);
        if (operation === 'inbox' && p.left) return {workspace: principal.tenantId, agent: id, left: true, batch: null};
        if (operation !== 'leave' && p.left) throw fail('Session has left; register it again to resume', 409);
        if (operation === 'subscribe') {
          p.topics = [...new Set(args.topics)].sort(); p.homepage = args.homepage; p.seen = time;
          result = {agent: id, homepage: p.homepage, mentions: true, topics: p.topics, effectiveAfter: p.ackCursor};
        } else if (operation === 'leave') {
          p.left = true; p.seen = time;
          result = {agent: id, left: true};
        } else if (operation === 'ack') {
          if (args.receipt === p.lastReceipt) return {agent: id, acknowledged: args.receipt, through: p.ackCursor};
          if (!p.pending || args.receipt !== p.pending.receipt) throw fail('Receipt does not match the pending delivery', 409);
          p.ackCursor = p.pending.through;
          p.acknowledgedMessages = (p.acknowledgedMessages || 0) + p.pending.messages.length;
          if (p.pending.more) p.nextHomeAt = time;
          p.lastReceipt = args.receipt; p.pending = null;
          p.lastAckAt = p.seen = time; p.acknowledgedBatches++;
          result = {agent: id, acknowledged: args.receipt, through: p.ackCursor};
        } else if (operation === 'publish') {
          if (Buffer.byteLength(args.text) > 1024) throw fail('Message exceeds 1024 UTF-8 bytes');
          const mentions = resolveMentions(state, args.text, args.mentions);
          const duplicate = state.messages.find(m => m.agent === id && m.requestId === args.id);
          if (duplicate) {
            if (duplicate.text !== args.text || duplicate.topic !== args.topic || JSON.stringify(duplicate.mentions || []) !== JSON.stringify(mentions)) throw fail('Retry id already used for different content', 409);
            return {agent: id, accepted: [duplicate.id]};
          }
          if (!state.messages.some(m => m.topic === args.topic) && new Set(state.messages.map(m => m.topic)).size >= 128) throw fail('Topic limit reached', 429);
          const message = {id: state.messages.length + 1, timestamp: time, agent: id, author: principal.userId, name: p.name,
            topic: args.topic, text: args.text, requestId: args.id, mentions};
          state.messages.push(message); p.seen = time;
          result = {agent: id, accepted: [message.id], mentions};
        } else if (operation === 'inbox') {
          if (args.receipt && args.receipt !== p.pending?.receipt) throw fail('Delivery is no longer pending; do not acknowledge another batch', 409);
          dirty = !p.lastPoll || time - p.lastPoll >= 60_000;
          if (dirty) p.lastPoll = p.seen = time;
          if (!p.pending) {
            const unseen = state.messages.slice(p.ackCursor);
            const urgent = m => m.mentions?.includes(id) || p.topics.includes(m.topic);
            const ready = unseen.some(m => m.agent !== id && urgent(m)) || time >= p.nextHomeAt;
            if (ready) {
              const messages = []; let through = p.ackCursor, bytes = 0;
              for (const m of unseen) {
                if (m.agent !== id && (p.homepage || urgent(m))) {
                  const reasons = [...(m.mentions?.includes(id) ? ['mention'] : []), ...(p.topics.includes(m.topic) ? ['topic'] : []), ...(p.homepage ? ['homepage'] : [])];
                  const {requestId, ...visible} = m, message = {...visible, reasons};
                  const size = Buffer.byteLength(JSON.stringify(message));
                  if (messages.length >= 8 || bytes + size > 8192) break;
                  messages.push(message); bytes += size;
                }
                through = m.id;
              }
              if (messages.length) {
                const receipt = hash(JSON.stringify([id, p.ackCursor, through, messages.map(m => m.id)]));
                p.pending = {receipt, createdAt: time, through, more: through < state.messages.length, messages}; p.batches++;
                p.lastDeliveryAt = time;
                p.nextHomeAt = time + 60_000; dirty = true;
              } else if (through !== p.ackCursor) {p.ackCursor = through; dirty = true;}
            }
          }
          result = {workspace: principal.tenantId, agent: id, name: p.name, batch: p.pending,
            pollAfterMs: 10_000};
        }
      }
      if (!dirty || await commit(key, version, state)) return result;
    }
    throw fail('Board busy; retry with the same request', 503);
  };
}
