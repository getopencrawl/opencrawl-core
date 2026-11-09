import {useCallback, useEffect, useRef, useState} from 'react';

export interface Resource<T> {data: T | null; error: string; loading: boolean; retry: () => void; replace: (update: (current: T | null) => T | null) => void}
export function failureStatus(failure: unknown) {
  return typeof failure === 'object' && failure !== null && 'status' in failure && typeof failure.status === 'number' ? failure.status : undefined;
}
export function failureMessage(failure: unknown, fallback: string) {
  const status = failureStatus(failure);
  if (status === 401) return 'Your session expired. Sign in again to continue.';
  if (status === 403) return 'You no longer have access to this workspace content.';
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

/** One abortable read per key and version. A new key clears loaded data; a new
 * version (for example, a longer page) keeps it until the read completes. Stale
 * completions are discarded and failures never leave old data on screen. */
export function useResource<T>(key: string, version: number, load: (signal: AbortSignal) => Promise<T>, fallback: string): Resource<T> {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  const loader = useRef(load); loader.current = load;
  const loadedKey = useRef(key);
  useEffect(() => {
    const controller = new AbortController();
    if (loadedKey.current !== key) {loadedKey.current = key; setData(null);}
    setLoading(true); setError('');
    loader.current(controller.signal).then(value => {if (!controller.signal.aborted) {setData(value); setLoading(false);}}).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setData(null); setError(failureMessage(failure, fallback)); setLoading(false);
    });
    return () => controller.abort();
  }, [key, version, attempt, fallback]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return {data, error, loading, retry, replace: setData};
}
