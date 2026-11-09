/** Full-text relevance shared by realm adapters.
 *
 * `text` keeps the standard analyzer (exact tokens: versions, identifiers, numbers).
 * `text.english` adds stemming and stopword removal, so "deadline" finds "deadlines" and
 * "rescheduled" finds "reschedule". Scores from both fields add up, so a passage matching
 * the exact token and its stem ranks above one matching either alone. Documents written
 * before the subfield existed still match through `text` while the backfill runs.
 */
export type MatchMode = 'any' | 'all' | 'phrase';
export const STEMMED = 'text.english';

/** Callers validate `match` against MatchMode; unknown modes use OR matching. */
export const SPARSE = 'textSparse';
/** With semantic retrieval the learned sparse score leads (measured on BEAM: evidence recall@40
 * 0.57 -> 0.68) and lexical scores refine it, so exact tokens such as versions still count.
 * `all` keeps requiring every term; `phrase` stays purely lexical. Passages not yet encoded
 * still match lexically. */
export const SEMANTIC_BOOST = 10;

export function textQuery(query: string, match: MatchMode | string = 'any', semantic = false) {
  if (match === 'phrase') return {match_phrase: {text: query}};
  const operator = match === 'all' ? 'and' : 'or';
  const lexical = [{match: {text: {query, operator}}}, {match: {[STEMMED]: {query, operator}}}];
  if (!semantic) return {bool: {should: lexical, minimum_should_match: 1}};
  const sparse = {neural_sparse: {[SPARSE]: {query_text: query, analyzer: 'bert-uncased', boost: SEMANTIC_BOOST}}};
  return match === 'all'
    ? {bool: {must: [{bool: {should: lexical, minimum_should_match: 1}}], should: [sparse]}}
    : {bool: {should: [...lexical, sparse], minimum_should_match: 1}};
}

/** Inclusive time bounds on the realm's common `timestamp` (session event time, memory file
 * modification time, connector item time). Invalid bounds are a client error. */
export function timeRange(after?: string, before?: string) {
  const bound = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw Object.assign(new Error('Invalid time range'), {status: 400});
    return new Date(value).toISOString();
  };
  const gte = bound(after), lte = bound(before);
  if (gte && lte && gte > lte) throw Object.assign(new Error('Invalid time range'), {status: 400});
  return gte || lte ? [{range: {timestamp: {...(gte ? {gte} : {}), ...(lte ? {lte} : {})}}}] : [];
}
