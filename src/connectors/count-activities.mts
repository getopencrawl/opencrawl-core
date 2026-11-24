import type {Environment, ProviderCatalog} from '../integrations/types.mjs';
import {connectorCountScope} from '../integrations/count-admission.mjs';
import {manifestKeys, recordKey} from '../integrations/counts.mjs';
import type {CountProgress, CountScope, createConnectorCounts} from '../state/connector-counts.mjs';
import {CountSnapshotBudgetExceeded, openCountSnapshot} from './count-snapshot.mjs';
import {readRecords} from './records.mjs';
import {invalidRecord, validateBinding} from './scope.mjs';
import type {ConditionalStore, ConnectorBinding} from './types.mjs';
import {advanceSourcePagination, sourcePaginationCheckpoint, sourcePaginationProgress} from './workflow.mjs';

export interface CountReference {tenantId: string; userId: string; connectionId: string; generation?: string}
interface CountOptions {
  resolve(reference: CountReference): Promise<{binding: ConnectorBinding; store: ConditionalStore}>;
  environment: Environment;
  providers: ProviderCatalog;
  state: Pick<ReturnType<typeof createConnectorCounts>, 'begin' | 'current' | 'adopt' | 'checkpoint' | 'publish' | 'deferBudget'>;
  /** Operator-selected retry budget for the authorized binding. A workflow input
   * never sets it; return undefined for all other connections to retain the default. */
  snapshotBudgetBytes?(scope: CountScope): number | undefined;
  openSnapshot?: typeof openCountSnapshot;
  heartbeat?(progress: Record<string, number>): void;
  checkCancelled?(): void;
}
interface Stream {full: boolean; primaryKey?: string[]}
type Selection = Record<string, number | null>;
const pagesPerActivity = 4;
const partsPerActivity = 16;
const pageSize = 1000;
const validSync = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;


function parsePart(rawPrefix: string, streams: Map<string, Stream>, key: string) {
  const path = key.slice(rawPrefix.length);
  const match = /^stream=([A-Za-z0-9_-]+)\/date=\d{4}-\d{2}-\d{2}\/sync=(\d+)\/[A-Za-z0-9_.-]+\.jsonl\.gz$/.exec(path);
  if (!match || !streams.has(match[1])) return null;
  const sync = Number(match[2]);
  if (!validSync(sync)) invalidRecord('Invalid Airbyte count sync');
  return {stream: match[1], sync, key};
}
function validateCursor(cursor: string | null) {
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || /[\x00-\x1f]/.test(cursor))) invalidRecord('Invalid count inventory cursor');
}
function validateSelection(selection: Selection, streams: Map<string, Stream>) {
  for (const [name, sync] of Object.entries(selection)) {
    const stream = streams.get(name);
    if (!stream || (stream.full ? !validSync(sync) : sync !== null)) invalidRecord('Invalid count stream selection');
  }
}
export function createCountActivities({resolve, environment, providers, state, snapshotBudgetBytes,
  openSnapshot = openCountSnapshot, heartbeat, checkCancelled = () => {}}: CountOptions) {
  const catalog = new Map(Object.values(providers).map(provider => {
    const keys = provider.keys || manifestKeys(provider.connector.manifest);
    const displayed = new Set([...provider.progressStream, ...(provider.progress || []).map(row => row.stream)]);
    return [provider.id, new Map(provider.streams.filter(stream => displayed.has(stream.name)).map(stream => [
      stream.name, {full: stream.syncMode.startsWith('full_refresh'), primaryKey: keys[stream.name]},
    ]))];
  }));
  async function source(input: CountReference) {
    checkCancelled();
    const {tenantId, userId, connectionId, generation} = input;
    if (!userId) invalidRecord('Count owner required');
    const {binding, store} = await resolve({tenantId, userId, connectionId, generation});
    validateBinding(binding);
    const streams = catalog.get(binding.provider);
    if (binding.tenantId !== tenantId || binding.connectionId !== connectionId || !store.bucket || !streams) invalidRecord('Count source scope mismatch');
    const scope = connectorCountScope(environment, tenantId, userId, connectionId, {bucket:store.bucket,rawPrefix:binding.rawPrefix,provider:binding.provider});
    return {scope, binding, store, streams};
  }
  type Source = Awaited<ReturnType<typeof source>>;
  async function list(current: Source, prefix: string, cursor: string | null) {
    validateCursor(cursor);
    const page = await current.store.listPage(prefix, {continuationToken:cursor, maxKeys:pageSize});
    if (!Array.isArray(page.keys) || page.keys.length > pageSize) invalidRecord('Invalid count inventory page');
    const next = page.nextToken ?? null;
    validateCursor(next);
    const parts = page.keys.flatMap(key => {
      if (typeof key !== 'string' || key.length > 1024 || !key.startsWith(prefix)) invalidRecord('Count object outside connector scope');
      const part = parsePart(current.binding.rawPrefix, current.streams, key);
      return part ? [part] : [];
    });
    return {parts, next};
  }

  // Candidates span pages. Incremental streams never need this first pass;
  // the GitHub display includes files, while only repositories need a full-sync inventory.
  async function selectPage(current: Source, cursor: string | null, succeeded: Set<number>, selection: Selection) {
    const full: string[] = [];
    for (const [name, stream] of current.streams) {
      if (stream.full) full.push(name);
      else selection[name] = null;
    }
    if (!full.length) {
      if (cursor !== null) invalidRecord('Invalid full-refresh count cursor');
      return null;
    }
    let name = full[0], token: string | null = null;
    if (cursor !== null) {
      const separator = cursor.indexOf('/');
      name = cursor.slice(0, separator);
      if (separator < 1 || !full.includes(name)) invalidRecord('Invalid full-refresh count cursor');
      token = cursor.slice(separator + 1) || null;
    }
    const {parts, next} = await list(current, current.binding.rawPrefix + 'stream=' + name + '/', token);
    for (const part of parts) {
      if (!succeeded.size || succeeded.has(part.sync)) selection[name] = Math.max(selection[name] ?? -1, part.sync);
    }
    const nextStream = full[full.indexOf(name) + 1];
    return next ? name + '/' + next : nextStream ? nextStream + '/' : null;
  }

  return {
    async beginConnectorCounts(input: CountReference & {passId: string; startedAt: number}) {
      const {scope} = await source(input);
      const head = await state.begin(scope, input.passId, input.startedAt);
      return head ? {generation:head.generation, revision:head.revision} : null;
    },
    async advanceConnectorCounts(input: CountReference & {countGeneration: string; revision: number}) {
      const current = await source(input), {scope, binding, streams} = current;
      const checkedSource = async () => {
        const fresh = await source(input);
        if (fresh.scope.binding !== scope.binding) invalidRecord('Count source binding changed');
        return fresh;
      };
      const head = await state.current(scope, input.countGeneration);
      if (!head) return null;
      if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision > head.revision) invalidRecord('Invalid count revision');
      if (input.revision < head.revision) return {revision:head.revision, done:false};
      const position = head.progress;
      let phase = position?.phase || 'inventory', cursor = position?.cursor ?? null;
      let pointer = position ? position.snapshot : head.statePointer;
      const scanId = position?.scanId || head.generation, succeeded = new Set(head.succeeded);
      const selection: Selection = {...position?.selection};
      validateSelection(selection, streams);
      let progress = sourcePaginationProgress(cursor, position?.pagination);
      let snapshot: Awaited<ReturnType<typeof openSnapshot>> | undefined;
      const started = performance.now();
      let changedParts = 0, complete = false;
      try {
        for (let pageNumber = 0; pageNumber < pagesPerActivity; pageNumber++) {
          checkCancelled();
          let next: string | null;
          if (phase === 'inventory') {
            next = await selectPage(current, cursor, succeeded, selection);
          } else {
            if (!snapshot) {
              snapshot = await openSnapshot({store:current.store, connectionId:binding.connectionId, rawPrefix:binding.rawPrefix,
                maxSnapshotBytes:snapshotBudgetBytes?.(scope)});
              if (snapshot.observedPointer !== pointer || snapshot.observedPointer !== head.statePointer) {
                // A successful S3 CAS can outlive the transaction that tried to
                // advance the cursor. Relist from the real object's exact receipts.
                await checkedSource();
                const adopted = await state.adopt(scope, head.generation, head.revision, snapshot.observedPointer);
                return adopted ? {revision:head.revision+1, done:false} : null;
              }
              for (const [name, sync] of Object.entries(selection)) {
                if (sync !== null) snapshot.selectFull(name, sync, succeeded.has(sync), scanId);
              }
            }
            const page = await list(current, binding.rawPrefix + 'stream=', cursor);
            let exhausted = true;
            for (const {key, stream, sync} of page.parts) {
              const chosen = selection[stream];
              if ((chosen !== null && chosen !== sync) || snapshot.hasPart(stream,chosen,key)) continue;
              if (changedParts >= partsPerActivity || (changedParts > 0 && performance.now() - started > 30_000)) {
                exhausted = false;
                break;
              }
              const reader = changedParts ? await checkedSource() : current;
              await snapshot.withPart(stream, chosen, key, async add => {
                await readRecords(reader.store, key, envelope => {
                  checkCancelled();
                  add(recordKey(envelope._airbyte_data, streams.get(stream)!.primaryKey));
                }, {mode:'count', heartbeat, maxExpanded:(binding.provider === 'github' ? 2 : 1) * 1024 ** 3});
              });
              changedParts++;
              heartbeat?.({changedParts});
            }
            // The newly saved object receipts are the within-page checkpoint.
            // A retry can relist this bounded page without persisting raw keys in PostgreSQL.
            if (!exhausted) break;
            next = page.next;
          }
          const advanced = advanceSourcePagination(progress, {keys:[],cursor:next});
          if (advanced) {cursor = next; progress = advanced;}
          else if (phase === 'inventory') {cursor = null; progress = sourcePaginationProgress(null); phase = 'parts';}
          else {complete = true; break;}
        }
        // Reauthorize before uploading objects or promoting a pointer after a long scan.
        await checkedSource();
        const active = await state.current(scope, head.generation);
        if (!active) return null;
        if (active.revision !== head.revision) return {revision:active.revision, done:false};
        // Compress before taking the row lock. The state transaction fences the generation
        // and expected revision before allowing the one conditional object write.
        if (complete) snapshot!.finalize();
        const prepared = snapshot?.dirty ? await snapshot.prepareSave() : undefined;
        if (prepared) pointer = prepared.pointer;
        checkCancelled();
        if (complete) {
          const summary = Object.fromEntries(Object.entries(snapshot!.summary()).filter(([stream]) => streams.has(stream)));
          const written = await state.publish(scope, head.generation, head.revision, summary, pointer, prepared?.write);
          return written ? {revision:head.revision+1,done:true} : null;
        }
        const updated: CountProgress = {phase, cursor, selection, snapshot:pointer, scanId,
          ...(cursor && {pagination:sourcePaginationCheckpoint(progress)})};
        const written = await state.checkpoint(scope, head.generation, head.revision, updated, prepared?.write);
        return written ? {revision:head.revision+1,done:false} : null;
      } catch (error) {
        if (error instanceof CountSnapshotBudgetExceeded) await state.deferBudget(scope, head.generation, head.revision);
        throw error;
      } finally {await snapshot?.close();}
    },
  };
}
export type CountActivities = ReturnType<typeof createCountActivities>;
