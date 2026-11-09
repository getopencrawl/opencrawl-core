import type {ConsoleDataAdapter, DiagnosticSearch} from './types.js';

export interface SearchSnapshot {
  query: string;
  result: DiagnosticSearch | null;
  state: 'idle' | 'loading' | 'complete' | 'failed' | 'canceled';
  error: string;
}
function message(failure: unknown) {
  const status = typeof failure === 'object' && failure !== null && 'status' in failure ? failure.status : undefined;
  if (status === 401) return 'Your session expired. Sign in again to inspect search results.';
  if (status === 403) return 'You no longer have access to inspect these search results.';
  return failure instanceof Error ? failure.message : 'The query could not complete. Try again.';
}

/** No result survives a new query, cancellation, failure, or a changed adapter. */
export class SearchReader {
  private value: SearchSnapshot = {query: '', result: null, state: 'idle', error: ''};
  private request: AbortController | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly adapter: Pick<ConsoleDataAdapter, 'search'>) {}
  readonly snapshot = () => this.value;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {this.listeners.delete(listener);};
  };
  private publish(value: SearchSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  cancel() {
    this.request?.abort(); this.request = null;
    this.publish({...this.value, result: null, state: 'canceled', error: ''});
  }
  suspend() {if(this.request)this.cancel();}
  async search(input: string) {
    const query = input.trim();
    if (!query || query.length > 4000) return;
    this.request?.abort();
    const request = new AbortController(); this.request = request;
    this.publish({query, result: null, state: 'loading', error: ''});
    try {
      const result = await this.adapter.search(query, request.signal);
      if (this.request === request && !request.signal.aborted) this.publish({query, result, state: 'complete', error: ''});
    } catch (failure) {
      if (this.request === request && !request.signal.aborted) this.publish({query, result: null, state: 'failed', error: message(failure)});
    } finally {
      if (this.request === request) this.request = null;
    }
  }
}
