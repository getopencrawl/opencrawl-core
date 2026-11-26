import {z} from 'zod';
import {fail} from '../errors.mjs';
import {capturePage} from '../application/capture-links.mjs';
import {transcriptCitation} from '../application/transcript-links.mjs';

const text = (max: number) => z.string().trim().min(1).max(max);
const intentId = z.string().regex(/^[a-z0-9]{8,16}$/);
const termName = z.string().max(240).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/);
const sourceId = z.string().regex(/^sessions:[a-zA-Z0-9_-]{1,200}$/);
const citation = z.strictObject({id: sourceId, quote: z.string().min(1).max(4000).refine(s => !!s.trim())});
const citations = z.array(citation).min(1);
export const intentDraftSchema = z.strictObject({
  intents: z.array(z.strictObject({
    id: intentId, statement: text(4000), path: z.array(text(160)).min(1).max(16),
    sources: citations, terms: z.array(termName).default([]),
  })),
  terms: z.array(z.strictObject({
    name: termName, label: text(160), definition: text(2000),
    aliases: z.array(text(160)), sources: citations,
  })),
  conflicts: z.array(z.strictObject({left: intentId, right: intentId, reason: text(2000)})).default([]),
});
export type IntentDraft = z.output<typeof intentDraftSchema>;
export type IntentCitation = z.output<typeof citation>;

export interface IntentSource {
  id: string;
  url: string;
  owner: string;
  sessionId: string;
  harness: string;
  role: 'user' | 'assistant';
  timestamp: string;
}

/** Source identity and text come from an authorized session read, never the extraction model. */
export interface IntentPassage extends IntentSource {tenantId: string; text: string}
export interface IntentCorpus extends IntentDraft {sources: IntentSource[]}

export function sessionEventPath(input: string, origin: string) {
  const url = new URL(input, origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password || url.search ||
      capturePage(url.pathname)?.collection !== 'sessions' || !transcriptCitation(url.hash)) {
    fail(400, 'Expected an original session event link');
  }
  return url.pathname + url.hash;
}

function unique(keys: string[], kind: string) {
  if (new Set(keys).size !== keys.length) fail(400, 'Duplicate ' + kind);
}

export function groundIntentCorpus(input: unknown, passages: readonly IntentPassage[], origin: string): IntentCorpus {
  const parsed = intentDraftSchema.safeParse(input);
  if (!parsed.success) fail(400, 'Invalid intent corpus');
  const draft = parsed.data;
  const intentIds = new Set(draft.intents.map(i => i.id));
  const termNames = new Set(draft.terms.map(t => t.name));
  unique(draft.intents.map(i => i.id), 'intent ID');
  unique(draft.terms.map(t => t.name), 'glossary name');
  const found = new Map(passages.map(p => [p.id, p]));
  const cited = new Map<string, IntentSource>();
  for (const record of [...draft.intents, ...draft.terms]) {
    unique(record.sources.map(s => JSON.stringify([s.id, s.quote])), 'citation');
    let user = false;
    for (const {id, quote} of record.sources) {
      const p = found.get(id);
      if (!p || !['user', 'assistant'].includes(p.role) || !p.owner || !p.sessionId || !p.harness ||
          !Number.isFinite(Date.parse(p.timestamp)) || !p.text.includes(quote)) {
        fail(400, 'Citation does not match a recorded passage');
      }
      const {text: _text, tenantId: _tenant, ...metadata} = p;
      cited.set(id, {...metadata, url: sessionEventPath(p.url, origin)});
      user ||= p.role === 'user';
    }
    if (!user) fail(400, 'A decision needs user evidence');
    if ('terms' in record) {
      unique(record.terms, 'term reference');
      if (record.terms.some(t => !termNames.has(t))) fail(400, 'Unknown glossary name');
    }
  }
  const pairs = [];
  for (const conflict of draft.conflicts) {
    if (conflict.left === conflict.right || !intentIds.has(conflict.left) || !intentIds.has(conflict.right)) {
      fail(400, 'Conflict must refer to two existing intents');
    }
    pairs.push([conflict.left, conflict.right].sort().join('/'));
  }
  unique(pairs, 'conflict');
  return {...draft, sources: [...cited.values()]};
}

/** Hide all derived text for a record if any supporting session is no longer shared. */
export function visibleIntentCorpus(corpus: IntentCorpus, readable: ReadonlySet<string>): IntentCorpus {
  const visible = (record: {sources: IntentCitation[]}) => record.sources.every(s => readable.has(s.id));
  const terms = corpus.terms.filter(visible);
  const names = new Set(terms.map(t => t.name));
  const intents = corpus.intents.filter(visible).map(i => ({...i, terms: i.terms.filter(t => names.has(t))}));
  const ids = new Set(intents.map(i => i.id));
  const cited = new Set([...intents, ...terms].flatMap(r => r.sources.map(s => s.id)));
  return {intents, terms, sources: corpus.sources.filter(s => cited.has(s.id)),
    conflicts: corpus.conflicts.filter(c => ids.has(c.left) && ids.has(c.right))};
}
