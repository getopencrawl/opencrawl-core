import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {accessFailure, consoleResourceKey, createConsoleQueryClient} from '../data.tsx';
import type {Bootstrap, ProductApi} from './api.ts';

/** Bootstrap is shared by the shell and Setup polling. Only a freshly
 * admitted document can seed this query after a full navigation. */
export function useAdmission<B extends Bootstrap>(api: ProductApi<B>, initial: B | undefined, setupPage: boolean) {
  const key = useMemo(() => consoleResourceKey(api, 'bootstrap'), [api]);
  const [client] = useState(() => {
    const cache = createConsoleQueryClient();
    if (initial) cache.setQueryData(key, initial, {updatedAt: 1});
    return cache;
  });
  const [denial, setDenial] = useState('');
  const blocked = useRef(false);
  const invalidateAccess = useCallback((cause: unknown) => {
    blocked.current = true;
    setDenial(cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : 'Your workspace access changed. Sign in again.');
    void client.cancelQueries();
    client.removeQueries();
  }, [client]);
  const query = useQuery({queryKey: key, queryFn: ({signal}) => api.bootstrap(signal), enabled: !denial,
    staleTime: 0, refetchInterval: setupPage ? 3000 : 60_000,
    refetchOnWindowFocus: 'always'}, client);
  useEffect(() => {
    client.mount();
    const denied = (event: Event) => invalidateAccess(event instanceof CustomEvent ? event.detail : undefined);
    const focus = () => {if (!blocked.current && document.visibilityState === 'visible') void client.refetchQueries({queryKey:key}, {cancelRefetch:false});};
    window.addEventListener('opencrawl:access-denied', denied);
    window.addEventListener('focus', focus);
    return () => {window.removeEventListener('opencrawl:access-denied', denied);window.removeEventListener('focus', focus);client.unmount();client.clear();};
  }, [client, key, invalidateAccess]);
  const refresh = async () => {
    const result = await query.refetch({cancelRefetch: true, throwOnError: true});
    if (!result.data || blocked.current) throw new Error('Your workspace access changed. Sign in again.');
    return result.data;
  };
  const retry = () => {blocked.current = false; setDenial(''); void query.refetch({cancelRefetch:false});};
  const forbidden = accessFailure(query.error);
  return {accessDenied: Boolean(denial) || forbidden, data: denial || forbidden ? null : query.data ?? null,
    error: denial || (query.error?.message ?? ''), invalidateAccess, refresh, retry,
    rename: (name: string) => client.setQueryData<B>(key, current => current && {...current, workspace: {...current.workspace, name}})};
}
