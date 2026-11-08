export interface SourcePage {keys: string[]; cursor: string | null; ignored?: number}
export interface SourceProgress {anchor: string | null; window: bigint; distance: bigint}
export interface SourceCheckpoint {version: number; anchor: string | null; window: string; distance: string}
export interface ConnectorSegmentInput { cursor?: string | null; paginationProgress?: SourceCheckpoint; paginationFailure?: string; failed?: number;}
export type ActivityInput<T extends ConnectorSegmentInput> = Omit<T, 'paginationProgress' | 'paginationFailure'>;
export interface ConnectorActivities<T extends ConnectorSegmentInput = ConnectorSegmentInput> {
 listPage(input: ActivityInput<T> & {cursor: string | null; paginationFailure?: string}): Promise<SourcePage>;
 processObject(input: ActivityInput<T> & {key: string}): Promise<{records: number}>;
}
/** Deterministic orchestration, injected durable activities; no cloud/SDK dependency.
 * Adapter continues as new with the cursor after each bounded segment.
 */
const paginationFailures = {
  cycle: 'Source pagination cursor cycle detected',
  'invalid-cursor': 'Invalid source pagination cursor',
  'invalid-progress': 'Invalid source pagination progress',
  'invalid-page': 'Invalid source pagination page',
};
export type PaginationFailure = keyof typeof paginationFailures;
export class SourcePaginationError extends Error {
  declare code: PaginationFailure;
  constructor(code: PaginationFailure) {
    super(paginationFailures[code]);
    this.code = code;
  }
}

// Activities enforce pending failures at an existing durable command boundary.
// Older workflow code replays the same ActivityFailure without knowing the guard.
export function assertSourcePaginationInput(input: {paginationFailure?: unknown}) {
  if (input.paginationFailure !== undefined) {
    throw new SourcePaginationError(typeof input.paginationFailure === 'string' && Object.hasOwn(paginationFailures, input.paginationFailure) ? input.paginationFailure as PaginationFailure : 'invalid-progress');
  }
}

export function assertSourcePaginationPage(page: unknown): asserts page is SourcePage {
  const candidate = page as {keys?: unknown; cursor?: unknown} | null | undefined;
  if (!candidate || !Array.isArray(candidate.keys) || candidate.keys.some((key: unknown) => typeof key !== 'string')) throw new SourcePaginationError('invalid-page');
  if (candidate.cursor !== null && (typeof candidate.cursor !== 'string' || !candidate.cursor)) throw new SourcePaginationError('invalid-cursor');
}

// One guard for durable segments, the local CLI, and nested snapshot inventories.
export function sourcePaginationProgress(cursor: string | null = null, state?: SourceCheckpoint): SourceProgress {
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

export function advanceSourcePagination(progress: SourceProgress | null, page: SourcePage): SourceProgress | null {
  assertSourcePaginationPage(page);
  const cursor = page.cursor;
  if (cursor === null) return null;
  if (cursor === progress!.anchor) throw new SourcePaginationError('cycle');
  // Brent's algorithm retains one checkpoint token across segment boundaries.
  // Decimal BigInt counters use logarithmic bytes, without a page-count ceiling.
  const distance = progress!.distance + 1n;
  return distance === progress!.window
    ? {anchor: cursor, window: progress!.window * 2n, distance: 0n}
    : {...progress!, distance};
}

export function sourcePaginationCheckpoint(progress: SourceProgress | null | undefined): SourceCheckpoint | undefined {
  return progress ? {version: 1, anchor: progress.anchor, window: String(progress.window), distance: String(progress.distance)} : undefined;
}

export async function runConnectorSegment<T extends ConnectorSegmentInput>(input: T, {listPage, processObject}: ConnectorActivities<T>, {deferPaginationFailure = false} = {}) {
  let cursor = input.cursor || null, indexed = 0, failed = 0;
  let progress: SourceProgress | null, paginationFailure: PaginationFailure | undefined;
  function guard<T>(operation: () => T): T | null {
    try { return operation(); }
    catch (error) {
      if (!deferPaginationFailure || !(error instanceof SourcePaginationError)) throw error;
      paginationFailure = error.code;
      return null;
    }
  }
  progress = guard(() => {
    assertSourcePaginationInput(input);
    return sourcePaginationProgress(input.cursor ?? null, input.paginationProgress);
  });
  const {paginationProgress: _progress, paginationFailure: _failure, ...activityInput} = input;
  for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
    const page = await listPage({...activityInput, cursor, ...(paginationFailure && {paginationFailure})});
    if (!paginationFailure) progress = guard(() => advanceSourcePagination(progress, page));
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
  return {cursor, indexed, failed, ...(paginationFailure && {paginationFailure}), ...(progress && {paginationProgress: sourcePaginationCheckpoint(progress)})};
}
