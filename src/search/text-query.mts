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
export function textQuery(query: string, match: MatchMode | string = 'any') {
  if (match === 'phrase') return {match_phrase: {text: query}};
  const operator = match === 'all' ? 'and' : 'or';
  return {bool: {
    should: [
      {match: {text: {query, operator}}},
      {match: {[STEMMED]: {query, operator}}},
    ],
    minimum_should_match: 1,
  }};
}
