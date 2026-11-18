import type {DiagnosticSearch, SearchResponse} from './reports.mjs';

export const SEARCH_PAGE_SIZE = 25;
export const SOURCE_WINDOW = 100;
export const MAX_SEARCH_PAGE = Math.ceil(4 * SOURCE_WINDOW / SEARCH_PAGE_SIZE);

/** Each source contributes its first hit, then its second, and so on. Scores
 * from different indexes aren't comparable. Page only already-authorized hits. */
export function diagnosticPage(result: DiagnosticSearch, page: number): DiagnosticSearch {
  const sources = [
    result.sessions?.map(item => item.response) ?? [],
    result.connectors?.responses ?? [],
    result.memories ? [result.memories] : [],
    result.board ? [result.board] : [],
  ];
  const counts = sources.map(responses => responses.reduce((sum, response) => sum + (response.hits?.hits?.length ?? 0), 0));
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const end = start + SEARCH_PAGE_SIZE;
  const ranges = counts.map(() => ({skip: 0, take: 0}));
  let position = 0;
  for (let rank = 0; rank < Math.max(...counts) && position < end; rank++) {
    for (const [source, count] of counts.entries()) {
      if (rank >= count) continue;
      if (position < start) ranges[source].skip++;
      else if (position < end) ranges[source].take++;
      position++;
    }
  }
  // A source may contain several raw response envelopes. Preserve their
  // metadata, including failed shards, while slicing across envelope boundaries.
  function slice(response: SearchResponse, range: {skip: number; take: number}): SearchResponse {
    const hits = response.hits?.hits;
    if (!hits) return response;
    const skipped = Math.min(hits.length, range.skip);
    const selected = hits.slice(skipped, skipped + range.take);
    range.skip -= skipped;
    range.take -= selected.length;
    return {...response, hits: {...response.hits, hits: selected}};
  }
  const hasNext = counts.reduce((sum, count) => sum + count, 0) > end;
  const windowLimited = sources.some((responses, source) => counts[source] >= SOURCE_WINDOW &&
    (responses.some(response => response.truncated || (response.hits?.total?.value ?? 0) > SOURCE_WINDOW) ||
      (source === 1 && result.connectors?.truncated)));
  return {...result,
    sessions: result.sessions?.map(item => ({...item, response: slice(item.response, ranges[0])})),
    connectors: result.connectors && {...result.connectors, responses: result.connectors.responses?.map(response => slice(response, ranges[1]))},
    memories: result.memories && slice(result.memories, ranges[2]),
    board: result.board && slice(result.board, ranges[3]),
    page: {number: page, hasNext, ...(windowLimited && !hasNext ? {windowLimited: true} : {})},
  };
}
