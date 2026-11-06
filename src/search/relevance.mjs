/** Relevance scoring shared by OpenCrawl's OpenSearch-backed searches.
 *
 * People search with whole questions as often as with keywords ("On the customer page, which
 * button is between 'Delete' and 'Back'?"). Requiring every term (`operator: and`) returns
 * nothing for such queries, because no passage contains every word of a sentence. Instead:
 *  - any term may match, and BM25 ranks passages that match more and rarer terms higher;
 *  - quoted phrases in the query ("Delete Customer") score extra when they appear verbatim.
 * Keyword queries keep their precision: a passage containing all terms still ranks first.
 * Callers keep their own scope filters; this only builds the scoring clause.
 */

// Quotes only count at word boundaries, so apostrophes ("it's", "users'") never open a phrase.
const QUOTED = /(?<![\p{L}\p{N}])["“”'‘’`]([\p{L}\p{N}][^"“”‘’`\n]{0,78}?[^\s"“”‘’`'])["“”'‘’`](?![\p{L}\p{N}])/gu;

/** Quoted phrases in a query, e.g. `'Delete Customer'` or `"Filters"`. */
export function quotedPhrases(query) {
  const phrases = new Set();
  for (const [, phrase] of query.matchAll(QUOTED)) phrases.add(phrase.trim());
  return [...phrases].slice(0, 16);
}

/** Scoring clause for `query` over `fields` (OpenSearch boost syntax, e.g. `title^2`). */
export function relevanceQuery(query, {fields = ['text'], phraseBoost = 3} = {}) {
  const terms = fields.length === 1 ? {match: {[fields[0]]: {query}}} : {multi_match: {query, fields, type: 'most_fields'}};
  const should = [terms];
  for (const phrase of quotedPhrases(query)) {
    for (const field of fields) {
      const [name, boost = '1'] = field.split('^');
      should.push({match_phrase: {[name]: {query: phrase, slop: 1, boost: phraseBoost * Number(boost)}}});
    }
  }
  return {bool: {should, minimum_should_match: 1}};
}

/** Split text into passages of at most `size` characters, preferring line boundaries. */
export function passages(text, size = 8000) {
  const out = [];
  let current = '';
  for (const line of String(text).split('\n')) {
    for (let start = 0; start < Math.max(line.length, 1); start += size) {
      const piece = line.slice(start, start + size);
      if (current && current.length + piece.length + 1 > size) { out.push(current); current = ''; }
      current += (current ? '\n' : '') + piece;
    }
  }
  if (current || !out.length) out.push(current);
  return out;
}

/** Reciprocal rank fusion: merge ranked lists of hits by `key`, weighting each list. */
export function fuseRankings(lists, {key = hit => hit.id, k = 60} = {}) {
  const fused = new Map();
  for (const {hits, weight = 1} of lists) {
    hits.forEach((hit, rank) => {
      const id = key(hit), row = fused.get(id) ?? {hit, score: 0};
      row.score += weight / (k + rank + 1);
      fused.set(id, row);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).map(({hit, score}) => ({...hit, score}));
}
