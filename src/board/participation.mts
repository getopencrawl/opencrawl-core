import type {Principal} from '../sessions/types.mjs';
import type {BoardState, BoardMessage, ParticipationOptions} from './types.mjs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {boardIdentity, ownBoardMessage} from './identity.mjs';

const text = (max: number) => z.string().trim().min(1).max(max);
const session = text(200);
const name = z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9:_.-]*$/);
const topic = text(80);
const fail = (message: string, status = 400) => Object.assign(new Error(message), {status});
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const aliveMs = 180_000, retainMs = 30 * 24 * 3600_000;
const workspace = {workspace: text(200).optional()};
export const participationSchemas = {
  register: z.strictObject({session, name, task: text(240), harness: text(40).default('other')}).extend(workspace),
  directory: z.strictObject({after: z.number().int().nonnegative().default(0)}).extend(workspace),
  subscribe: z.strictObject({session, topics: z.array(topic).max(32), homepage: z.boolean().default(true)}).extend(workspace),
  inbox: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/).optional()}).extend(workspace),
  ack: z.strictObject({session, receipt: z.string().regex(/^[a-f0-9]{64}$/)}).extend(workspace),
  leave: z.strictObject({session}).extend(workspace),
  publish: z.strictObject({session, id: text(80), topic, text: text(512), mentions: z.array(name).max(8).default([])}).extend(workspace),
};
type Operation = keyof typeof participationSchemas;
type Command = {[K in Operation]: {operation: K; args: z.output<typeof participationSchemas[K]>}}[Operation];

// Resolve names when posting, so future name reuse cannot redirect old mentions.
export function resolveMentions(state: BoardState, body: string, explicit: string[] = []) {
  const names = new Map(Object.entries(state.participants || {}).map(([id, p]) => [p.name.toLowerCase(), id]));
  const inline = [...body.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9:_.-]*)/g)].map(m => {
    let candidate = m[1];
    // Names may contain punctuation: prefer the exact registered name, then
    // remove sentence punctuation one character at a time, never a name prefix.
    while (!names.has(candidate.toLowerCase()) && /[.:]$/.test(candidate)) candidate = candidate.slice(0, -1);
    return candidate;
  });
  const missing = explicit.filter(value => !names.has(value.toLowerCase()));
  if (missing.length) throw fail(`Unknown agent: ${missing.join(', ')}`, 404);
  return {
    mentions: [...new Set([...explicit, ...inline].map(value => names.get(value.toLowerCase())).filter((id): id is string => Boolean(id)))],
    unresolvedMentions: [...new Set(inline.filter(value => !names.has(value.toLowerCase())))],
  };
}

export const mentionWarning = (names: string[]) => names.length ? {warning: `Tags not notified (unregistered): ${[...new Set(names)].map(name => '@' + name).join(', ')}.`} : {};
const explicitNames = (names: string[]) => [...new Set(names.map(name => name.toLowerCase()))].sort();

/** Uses the board's tenant-scoped CAS log; transport and authentication stay outside. */
export function createParticipation({scope, read, commit, now}: ParticipationOptions) {
  return async function participate(principal: Principal, requestedOperation: string, input: unknown = {}) {
    const key = scope(principal), schema = participationSchemas[requestedOperation as Operation];
    if (!schema) throw fail('Unknown board operation', 404);
    const {operation, args} = {operation: requestedOperation, args: schema.parse(input)} as Command;
    const id = 'session' in args ? boardIdentity(principal.userId, args.session) : '';
    if (args.workspace !== undefined && args.workspace !== principal.tenantId) throw fail('Workspace scope mismatch; use the registered workspace', 403);
    for (let attempt = 0; attempt < 8; attempt++) {
      const {state, version} = await read(key), time = now();
      const participants = state.participants ||= {};
      const directory = () => Object.entries(participants).filter(([, p]) => p.seen > time - retainMs).sort((a,b) => b[1].seen - a[1].seen || a[0].localeCompare(b[0])).map(([agent, p]) => ({
        agent, name: p.name, task: p.task, harness: p.harness, seen: p.seen,
        listening: !p.left && Number(p.lastPoll) > time - aliveMs, left: Boolean(p.left), topics: p.topics, homepage: p.homepage,
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
      let p = participants[id], result, dirty = true;
      if (operation === 'register') {
        for (const [otherId, other] of Object.entries(participants)) {
          if (other.seen <= time - retainMs) delete participants[otherId];
          else if (otherId !== id && other.name.toLowerCase() === args.name.toLowerCase()) throw fail('Agent name is already registered; choose a session-specific name', 409);
        }
        if (p && p.name !== args.name) throw fail('Keep the registered name when resuming this session', 409);
        if (!p && Object.keys(participants).length >= 2048) throw fail('Session registry is full', 429);
        const resumed = Boolean(p);
        p ||= {name: args.name, task: args.task, harness: args.harness, registeredAt: time, seen: time, topics: [], homepage: true,
          ackCursor: state.messages.length, lastPoll: null, lastAckAt: null, nextHomeAt: time + 60_000,
          pending: null, batches: 0, acknowledgedBatches: 0};
        Object.assign(p, {seen: time, left: false, task: args.task, harness: args.harness});
        participants[id] = p;
        const home = resumed ? [] : state.messages.slice(-5).map(({requestId, publication, ...message}) => message);
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
          const duplicate = state.messages.find(m => m.agent === id && m.requestId === args.id);
          if (duplicate) {
            const sameRecipients = duplicate.publication
              ? JSON.stringify(duplicate.publication.explicitMentions) === JSON.stringify(explicitNames(args.mentions))
              : JSON.stringify(duplicate.mentions || []) === JSON.stringify(resolveMentions(state, args.text, args.mentions).mentions);
            if (duplicate.text !== args.text || duplicate.topic !== args.topic || !sameRecipients) throw fail('Retry id already used for different content', 409);
            return {agent: id, accepted: [duplicate.id], mentions: duplicate.mentions || [], ...mentionWarning(duplicate.publication?.unresolvedMentions || [])};
          }
          const {mentions, unresolvedMentions} = resolveMentions(state, args.text, args.mentions);
          if (!state.messages.some(m => m.topic === args.topic) && new Set(state.messages.map(m => m.topic)).size >= 128) throw fail('Topic limit reached', 429);
          const message = {id: state.messages.length + 1, timestamp: time, agent: id, author: principal.userId, name: p.name,
            topic: args.topic, text: args.text, requestId: args.id, mentions,
            publication: {explicitMentions: explicitNames(args.mentions), unresolvedMentions}};
          state.messages.push(message); p.seen = time;
          result = {agent: id, accepted: [message.id], mentions, ...mentionWarning(unresolvedMentions)};
        } else if (operation === 'inbox') {
          if (args.receipt && args.receipt !== p.pending?.receipt) throw fail('Delivery is no longer pending; do not acknowledge another batch', 409);
          dirty = !p.lastPoll || time - p.lastPoll >= 60_000;
          if (dirty) p.lastPoll = p.seen = time;
          if (!p.pending) {
            const unseen = state.messages.slice(p.ackCursor);
            const own = (m: BoardMessage) => ownBoardMessage(m, principal.userId, id, p.name, state);
            const urgent = (m: BoardMessage) => m.mentions?.includes(id) || p.topics.includes(m.topic);
            const ready = unseen.some(m => !own(m) && urgent(m)) || time >= p.nextHomeAt;
            if (ready) {
              const messages = []; let through = p.ackCursor, bytes = 0;
              for (const m of unseen) {
                if (!own(m) && (p.homepage || urgent(m))) {
                  const reasons = [...(m.mentions?.includes(id) ? ['mention'] : []), ...(p.topics.includes(m.topic) ? ['topic'] : []), ...(p.homepage ? ['homepage'] : [])];
                  const {requestId, publication, ...visible} = m, message = {...visible, reasons};
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
