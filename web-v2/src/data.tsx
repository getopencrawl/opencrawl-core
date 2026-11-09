import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {QueryCache, QueryClient, QueryClientProvider, useQuery} from '@tanstack/react-query';
import {Notice} from './design/components.tsx';

export function responseStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}
export const accessFailure = (error: unknown) => [401, 402, 403].includes(responseStatus(error) ?? 0);
const transient = (error: unknown) => {const status = responseStatus(error); return status !== undefined && status >= 500 && status < 600;};
const message = (error: unknown) => error instanceof Error ? error.message : 'This information could not update. Try again.';
const owners = new WeakMap<object, number>();
let nextOwner = 0;
export function consoleResourceKey(owner: object, name = 'resource') {
  let id = owners.get(owner); if (id === undefined) {id = ++nextOwner; owners.set(owner, id);}
  return ['console', name, id] as const;
}
const CacheContext = createContext<QueryClient | null>(null);
const DenialContext = createContext<((error: unknown) => void) | null>(null);
export const useConsoleQueryClient = () => useContext(CacheContext);
export const useConsoleAccessFailure = () => useContext(DenialContext);
export const useHasConsoleCache = () => useContext(CacheContext) !== null;

export function createConsoleQueryClient(onAccessFailure?: (error: unknown) => void) {
  return new QueryClient({queryCache: new QueryCache({onError: error => {if (accessFailure(error)) onAccessFailure?.(error);}}),
    defaultOptions: {queries: {staleTime: 30_000, gcTime: typeof window === 'undefined' ? Infinity : 10 * 60_000, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true}, mutations: {retry: false}}});
}

/** One memory-only cache per trusted runtime scope. Replace the provider on identity changes. */
export function ConsoleDataProvider({scopeKey, children, onAccessFailure}: {scopeKey: string; children: ReactNode; onAccessFailure?: (error: unknown) => void}) {
  return <ScopedCache key={scopeKey} onAccessFailure={onAccessFailure}>{children}</ScopedCache>;
}
function ScopedCache({children, onAccessFailure}: {children: ReactNode; onAccessFailure?: (error: unknown) => void}) {
  const handler = useRef(onAccessFailure); handler.current = onAccessFailure;
  const [denied, setDenied] = useState('');
  const deny = useCallback((error: unknown) => {setDenied(message(error)); handler.current?.(error);}, []);
  const [client] = useState(() => createConsoleQueryClient(deny));
  useEffect(() => {
    const visibility = () => {if (document.visibilityState === 'hidden') void client.cancelQueries();};
    const focus = () => {if (document.visibilityState === 'visible') void client.refetchQueries({type:'active',stale:true});};
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus',focus);
    return () => {document.removeEventListener('visibilitychange', visibility);window.removeEventListener('focus',focus);client.clear();};
  }, [client]);
  useEffect(() => {if (denied) {void client.cancelQueries(); client.clear();}}, [client, denied]);
  return <CacheContext.Provider value={client}><DenialContext.Provider value={deny}><QueryClientProvider client={client}>{denied ? <Notice tone="danger">{denied}</Notice> : children}</QueryClientProvider></DenialContext.Provider></CacheContext.Provider>;
}

/** Preserve scoped reader/draft state without keeping hidden pages or polling mounted. */
export function useConsoleModel<T>(key: readonly unknown[], create: () => T): T {
  const client = useContext(CacheContext);
  return useMemo(() => {
    const cached = client?.getQueryData<T>(key);if(cached !== undefined)return cached;
    const model=create();client?.setQueryData(key,()=>model);return model;
  }, [client, JSON.stringify(key)]);
}

interface ResourceOptions {autoRefreshMilliseconds?: number; paused?: boolean; enabled?: boolean; staleMilliseconds?: number}
/** Serve cached data immediately; only the first read blocks, and server failures retain it. */
export function useConsoleResource<T>(key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>, {autoRefreshMilliseconds, paused = false, enabled = true, staleMilliseconds = 30_000}: ResourceOptions = {}) {
  const stableKey = useMemo(() => key, [JSON.stringify(key)]);
  const scoped = useContext(CacheContext);
  const [local] = useState(() => createConsoleQueryClient());
  const client = scoped ?? local;
  const [invalidated, setInvalidated] = useState('');
  const query = useQuery({queryKey: stableKey, queryFn: ({signal}) => read(signal), enabled: enabled && !paused,
    staleTime: staleMilliseconds, refetchInterval: autoRefreshMilliseconds || false, refetchIntervalInBackground: false}, client);
  useEffect(() => {if (paused) void client.cancelQueries({queryKey: stableKey, exact: true});}, [client, paused, stableKey]);
  // Query cancellation is shared: a prefetch and mounted page never duplicate a read.
  const reload = useCallback(async () => {setInvalidated(''); await query.refetch({cancelRefetch: false});}, [query.refetch]);
  const invalidate = useCallback((reason = 'Your workspace access changed. Sign in again.') => {
    setInvalidated(reason); void client.cancelQueries({queryKey: stableKey, exact: true}); client.removeQueries({queryKey: stableKey, exact: true});
  }, [client, stableKey]);
  const updateData = useCallback((change: (current: T) => T) => {client.setQueryData<T>(stableKey, current => current === undefined ? undefined : change(current));}, [client, stableKey]);
  const data = invalidated || query.error && !transient(query.error) ? null : query.data ?? null;
  return {data, error: invalidated || (query.error ? message(query.error) : ''), loading: data === null && query.isLoading, refreshing: query.isFetching && data !== null, reload, invalidate, updateData};
}

export function useConsolePrefetch(reads: ReadonlyArray<{key: readonly unknown[]; read: (signal: AbortSignal) => Promise<unknown>; staleMilliseconds?: number}>, enabled = true) {
  const client = useContext(CacheContext);
  useEffect(() => {
    if (!client || !enabled) return;
    for (const resource of reads) void client.prefetchQuery({queryKey: resource.key, queryFn: ({signal}) => resource.read(signal), staleTime: resource.staleMilliseconds ?? 30_000});
  }, [client, reads, enabled]);
}
