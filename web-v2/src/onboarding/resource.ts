import {useCallback, useEffect, useRef, useState} from 'react';

/** Cancels work on route changes and avoids overlapping or hidden-tab polling. */
export function useOnboardingResource<T>(read: (signal: AbortSignal) => Promise<T>, options: {interval?: number; initial?: T; enabled?: boolean} = {}) {
  const {interval, initial, enabled = true} = options;
  const [data, setData] = useState<T | undefined>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(initial === undefined && enabled);
  const [revision, setRevision] = useState(0);
  const readRef = useRef(read);
  readRef.current = read;
  const reload = useCallback(() => setRevision(value => value + 1), []);
  const replace = useCallback((value: T) => {setData(value); setError(null); setLoading(false);}, []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (active || document.hidden) return;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const value = await readRef.current(controller.signal);
        if (!disposed) {setData(value); setError(null);}
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : 'We couldn’t check your progress. Try again.');
      } finally {
        clearTimeout(timeout);
        active = null;
        if (!disposed) setLoading(false);
      }
    };
    void refresh();
    const onVisible = () => {if (!document.hidden) void refresh();};
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    const timer = interval ? setInterval(() => void refresh(), interval) : undefined;
    return () => {
      disposed = true;
      active?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [enabled, interval, revision]);
  return {data, error, loading, reload, replace};
}
