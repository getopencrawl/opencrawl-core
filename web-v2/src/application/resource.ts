import {consoleResourceKey, useConsoleResource} from '../index.ts';

/** Shared scope cache survives route changes; only initial reads show loading. */
export function useResource<T>(read: (signal: AbortSignal) => Promise<T>, options: {autoRefreshMilliseconds?: number | ((data: T | undefined) => number | false); paused?: boolean} = {}) {
  return useConsoleResource(consoleResourceKey(read), read, options);
}
