/** Deterministic orchestration, injected durable activities; no cloud/SDK dependency.
 * Adapter continues as new with the cursor after each bounded segment.
 */
export class SourcePaginationError extends Error {}

function paginationProgress(cursor, state) {
  if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new SourcePaginationError('Invalid source pagination cursor');
  if (state === undefined) return {anchor: cursor, window: 1n, distance: 0n};
  if (!state || state.version !== 1 || typeof state.anchor !== 'string' || !state.anchor ||
      typeof state.window !== 'string' || !/^[1-9][0-9]*$/.test(state.window) ||
      typeof state.distance !== 'string' || !/^(0|[1-9][0-9]*)$/.test(state.distance)) {
    throw new SourcePaginationError('Invalid source pagination progress');
  }
  const window = BigInt(state.window), distance = BigInt(state.distance);
  if (String(window) !== state.window || String(distance) !== state.distance ||
      !cursor || window < 2n || (window & (window - 1n)) !== 0n || distance >= window ||
      (distance === 0n) !== (state.anchor === cursor)) throw new SourcePaginationError('Invalid source pagination progress');
  return {anchor: state.anchor, window, distance};
}

function advancePagination(progress, cursor) {
  if (cursor === null) return null;
  if (typeof cursor !== 'string' || !cursor) throw new SourcePaginationError('Invalid source pagination cursor');
  if (cursor === progress.anchor) throw new SourcePaginationError('Source pagination cursor cycle detected');
  // Brent's algorithm retains one checkpoint token across segment boundaries.
  // Decimal BigInt counters use logarithmic bytes, without a page-count ceiling.
  const distance = progress.distance + 1n;
  return distance === progress.window
    ? {anchor: cursor, window: progress.window * 2n, distance: 0n}
    : {...progress, distance};
}

export async function runConnectorSegment(input, {listPage, processObject}, {trackPagination = true} = {}) {
  let cursor = input.cursor || null, indexed = 0, failed = 0;
  let progress = trackPagination ? paginationProgress(input.cursor ?? null, input.paginationProgress) : null;
  const {paginationProgress: _progress, ...withoutProgress} = input;
  const activityInput = trackPagination ? withoutProgress : input;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await listPage({...activityInput, cursor});
    if (trackPagination && (!page || !Array.isArray(page.keys) || page.keys.some(key => typeof key !== 'string'))) {
      throw new SourcePaginationError('Invalid source pagination page');
    }
    if (trackPagination) progress = advancePagination(progress, page.cursor);
    for (let offset = 0; offset < page.keys.length; offset += 2) {
      const results = await Promise.allSettled(page.keys.slice(offset, offset + 2).map(key => processObject({...activityInput, key})));
      for (const result of results) {
        if (result.status === 'fulfilled') indexed += result.value.records;
        else failed++;
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  return {cursor, indexed, failed, ...(progress && {paginationProgress: {
    version: 1, anchor: progress.anchor, window: String(progress.window), distance: String(progress.distance),
  }})};
}
