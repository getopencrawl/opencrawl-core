import {useCallback, useRef} from 'react';
import {accessFailure, consoleResourceKey, responseStatus, useConsoleAccessFailure, useConsoleQueryClient, useConsoleResource} from '../data.tsx';
import type {LibraryAdapter, LibraryContract, LibraryOperation} from './library-types.ts';

export interface Resource<T> {data: T | null; error: string; loading: boolean; retry: () => void; replace: (update: (current: T | null) => T | null) => void}
export const failureStatus = responseStatus;
export function failureMessage(failure: unknown, fallback: string) {
  const status = failureStatus(failure);
  if (status === 401) return 'Your session expired. Sign in again to continue.';
  if (status === 403) return 'You no longer have access to this workspace content.';
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

export const libraryResourceKey = (adapter: LibraryAdapter, operation: string, key: string, version = 0) => [...consoleResourceKey(adapter, 'library'), operation, key, version] as const;

/** Lists and viewers share the trusted workspace cache. Pagination keeps its current page while loading. */
export function useResource<T>(adapter: LibraryAdapter, operation: string, key: string, version: number, load: (signal: AbortSignal) => Promise<T>, fallback: string): Resource<T> {
  const resource = useConsoleResource(libraryResourceKey(adapter, operation, key, version), load);
  const previous = useRef<{key: string; data: T} | null>(null), identity = operation + '\n' + key;
  if (resource.data) previous.current = {key: identity, data: resource.data};
  const data = resource.data ?? (resource.loading && previous.current?.key === identity ? previous.current.data : null);
  return {data, error: resource.error || (!data && !resource.loading ? fallback : ''), loading:resource.loading || resource.refreshing,
    retry: () => {void resource.reload();}, replace: update => resource.updateData(current => update(current) ?? current)};
}

/** Invalidate lists and evict cached viewers after privacy/deletion writes, including uncertain outcomes. */
export function useLibraryMutation(adapter: LibraryAdapter): LibraryAdapter {
  const client = useConsoleQueryClient(), deny = useConsoleAccessFailure();
  return useCallback(async <O extends LibraryOperation>(operation: O, input: LibraryContract[O]['input'], signal: AbortSignal): Promise<LibraryContract[O]['output']> => {
    try {return await adapter(operation, input, signal);}
    catch (failure) {if (!signal.aborted && accessFailure(failure)) deny?.(failure);throw failure;}
    finally {
      if (!signal.aborted && client) {
        const queryKey = consoleResourceKey(adapter, 'library');
        client.removeQueries({queryKey, predicate: query => !query.isActive() || String(query.queryKey[3]).endsWith('/read')});
        void client.invalidateQueries({queryKey});
      }
    }
  }, [adapter, client, deny]);
}
