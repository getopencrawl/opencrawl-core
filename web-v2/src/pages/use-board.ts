import {useEffect, useMemo, useSyncExternalStore} from 'react';
import type {ConsoleDataAdapter} from './types.js';
import {BoardReader} from './board-reader.js';

export function useBoard(adapter: Pick<ConsoleDataAdapter, 'board'>, topic: string, topics: boolean, beforeCommit: () => void) {
  const reader = useMemo(() => new BoardReader(adapter, topic, topics, beforeCommit), [adapter, topic, topics, beforeCommit]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useEffect(() => {
    const refresh = () => {if (document.visibilityState === 'visible') void reader.refresh();};
    const visibility = () => {if (document.visibilityState === 'hidden') reader.cancel(); else refresh();};
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibility);
    refresh();
    return () => {window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', visibility); reader.cancel();};
  }, [reader]);
  return {...state, retry: () => reader.refresh(), older: () => reader.older()};
}
