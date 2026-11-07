/** Deterministic orchestration, injected durable activities; no cloud/SDK dependency.
 * Adapter continues as new with the cursor after each bounded segment.
 */
const paginationFailures = {
  cycle: 'Source pagination cursor cycle detected',
  'invalid-cursor': 'Invalid source pagination cursor',
  'invalid-progress': 'Invalid source pagination progress',
  'invalid-page': 'Invalid source pagination page',
};
export class SourcePaginationError extends Error {
  constructor(code) {
    super(paginationFailures[code]);
    this.code = code;
  }
}

// Activities enforce pending failures at an existing durable command boundary.
// Older workflow code replays the same ActivityFailure without knowing the guard.
export function assertSourcePaginationInput(input) {
  if (input.paginationFailure !== undefined) {
    throw new SourcePaginationError(typeof input.paginationFailure === 'string' && Object.hasOwn(paginationFailures, input.paginationFailure) ? input.paginationFailure : 'invalid-progress');
  }
}

export function assertSourcePaginationPage(page) {
  if (!page || !Array.isArray(page.keys) || page.keys.some(key => typeof key !== 'string')) throw new SourcePaginationError('invalid-page');
  if (page.cursor !== null && (typeof page.cursor !== 'string' || !page.cursor)) throw new SourcePaginationError('invalid-cursor');
}

function paginationProgress(cursor, state) {
  if (cursor !== null && (typeof cursor !== 'string' || !cursor)) throw new SourcePaginationError('invalid-cursor');
  if (state === undefined) return {anchor: cursor, window: 1n, distance: 0n};
  if (!state || state.version !== 1 || typeof state.anchor !== 'string' || !state.anchor ||
      typeof state.window !== 'string' || !/^[1-9][0-9]*$/.test(state.window) ||
      typeof state.distance !== 'string' || !/^(0|[1-9][0-9]*)$/.test(state.distance)) {
    throw new SourcePaginationError('invalid-progress');
  }
  const window = BigInt(state.window), distance = BigInt(state.distance);
  if (String(window) !== state.window || String(distance) !== state.distance ||
      !cursor || window < 2n || (window & (window - 1n)) !== 0n || distance >= window) throw new SourcePaginationError('invalid-progress');
  // A legacy worker can advance cursor while preserving this checkpoint unchanged.
  // The anchor is still a previously visited token; distance need not describe every
  // intervening page. Never infer corruption from anchor/current-cursor equality.
  return {anchor: state.anchor, window, distance};
}

function advancePagination(progress, cursor) {
  if (cursor === null) return null;
  if (typeof cursor !== 'string' || !cursor) throw new SourcePaginationError('invalid-cursor');
  if (cursor === progress.anchor) throw new SourcePaginationError('cycle');
  // Brent's algorithm retains one checkpoint token across segment boundaries.
  // Decimal BigInt counters use logarithmic bytes, without a page-count ceiling.
  const distance = progress.distance + 1n;
  return distance === progress.window
    ? {anchor: cursor, window: progress.window * 2n, distance: 0n}
    : {...progress, distance};
}

export async function runConnectorSegment(input, {listPage, processObject}, {deferPaginationFailure = false} = {}) {
  let cursor = input.cursor || null, indexed = 0, failed = 0;
  let progress, paginationFailure;
  function guard(operation) {
    try { return operation(); }
    catch (error) {
      if (!deferPaginationFailure || !(error instanceof SourcePaginationError)) throw error;
      paginationFailure = error.code;
      return null;
    }
  }
  progress = guard(() => {
    assertSourcePaginationInput(input);
    return paginationProgress(input.cursor ?? null, input.paginationProgress);
  });
  const {paginationProgress: _progress, paginationFailure: _failure, ...activityInput} = input;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await listPage({...activityInput, cursor, ...(paginationFailure && {paginationFailure})});
    if (!paginationFailure) progress = guard(() => {
      assertSourcePaginationPage(page);
      return advancePagination(progress, page.cursor);
    });
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
  return {cursor, indexed, failed, ...(paginationFailure && {paginationFailure}), ...(progress && {paginationProgress: {
    version: 1, anchor: progress.anchor, window: String(progress.window), distance: String(progress.distance),
  }})};
}
