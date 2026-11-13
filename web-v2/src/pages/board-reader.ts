import type {BoardMessage, BoardReport, ConsoleDataAdapter} from './types.js';

type Adapter = Pick<ConsoleDataAdapter, 'board'>;
export interface BoardSnapshot {
  report: BoardReport | null;
  busy: boolean;
  catchingUp: boolean;
  error: string;
}
interface Bridge {
  newest: BoardMessage;
  messages: BoardMessage[];
  next: number | null;
  summaries: BoardReport['topicSummaries'];
}
class HistoryChanged extends Error {}

const initial: BoardSnapshot = {report: null, busy: true, catchingUp: false, error: ''};
const samePost = (a: BoardMessage, b: BoardMessage) => a.id === b.id && a.timestamp === b.timestamp && a.topic === b.topic && a.agent === b.agent && a.name === b.name && a.text === b.text;

function transient(failure: unknown): boolean {
  return typeof failure === 'object' && failure !== null && 'status' in failure &&
    typeof failure.status === 'number' && Number.isInteger(failure.status) && failure.status >= 500 && failure.status <= 599;
}

/** An append-only board is paged by descending IDs. Never join pages across a gap. */
export class BoardReader {
  private value: BoardSnapshot = initial;
  private readonly listeners = new Set<() => void>();
  private request: AbortController | null = null;
  private bridge: Bridge | null = null;
  constructor(private readonly adapter: Adapter, private readonly topic: string, private readonly topics: boolean, private beforeCommit: () => void = () => {}, private readonly message?: number) {}
  setBeforeCommit(callback: () => void) {this.beforeCommit=callback;}
  readonly snapshot = () => this.value;
  readonly subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private publish(update: Partial<BoardSnapshot>) {
    const presentationChanged = ('report' in update && update.report !== this.value.report) ||
      ('error' in update && update.error !== this.value.error) ||
      ('catchingUp' in update && update.catchingUp !== this.value.catchingUp);
    if (this.value.report && presentationChanged) this.beforeCommit();
    this.value = {...this.value, ...update};
    for (const listener of this.listeners) listener();
  }
  private commit(report: BoardReport) {this.publish({report});}
  private active(request: AbortController) {return this.request === request && !request.signal.aborted;}
  cancel() {
    this.request?.abort(); this.request = null;
    this.publish({busy: false});
  }
  private async read(request: AbortController, before?: number) {
    const page = await this.adapter.board({...this.topic ? {topic: this.topic} : {}, ...before !== undefined ? {before} : {}}, request.signal);
    if (!this.active(request)) return null;
    let previous = before ?? Infinity;
    for (const message of page.messages) {
      if (!Number.isSafeInteger(message.id) || message.id <= 0 || message.id >= previous || (this.topic && message.topic !== this.topic)) throw new Error('The board returned an inconsistent page.');
      previous = message.id;
    }
    if (page.next !== null && (page.messages.length === 0 || page.next !== page.messages.at(-1)?.id)) throw new Error('The board returned an invalid page cursor.');
    return page;
  }
  private async following(request: AbortController, boundary: BoardMessage) {
    // Repeat one boundary post to detect a reset between individually authorized pages.
    if (boundary.id === Number.MAX_SAFE_INTEGER) throw new Error('The board cursor cannot advance safely.');
    const page = await this.read(request, boundary.id + 1);
    if (!page) return null;
    if (!page.messages[0] || !samePost(page.messages[0], boundary)) throw new HistoryChanged();
    const messages = page.messages.slice(1);
    if (!messages.length && page.next !== null) throw new Error('The board cursor did not advance.');
    return {...page, messages};
  }
  private failed(failure: unknown) {
    if (!transient(failure)) {this.bridge = null; this.publish({report: null, catchingUp: false});}
    this.publish({error: failure instanceof Error ? failure.message : 'Messages could not load. Try again.'});
  }
  private async run(operation: (request: AbortController) => Promise<void>) {
    if (this.request) return;
    const request = new AbortController(); this.request = request;
    this.publish({busy: true, error: ''});
    try {await operation(request);}
    catch (failure) {
      if (!this.active(request)) return;
      if (failure instanceof HistoryChanged) {
        // A staged chain may straddle a reset. Discard all of it before one fresh-head read.
        this.bridge = null;
        this.publish({report: null, catchingUp: false});
        try {
          const page = await this.read(request);
          if (page) this.commit(page);
        } catch (recoveryFailure) {
          if (this.active(request)) this.failed(recoveryFailure);
        }
      } else this.failed(failure);
    }
    finally {if (this.active(request)) {this.request = null; this.publish({busy: false});}}
  }
  private resolveBridge() {
    const bridge = this.bridge, current = this.value.report;
    if (!bridge || !current) return false;
    const match = bridge.messages.find(message => message.id === bridge.newest.id);
    const last = bridge.messages.at(-1);
    if (match && samePost(match, bridge.newest)) {
      // Load older may have extended current while a staged bridge waited for its next chunk.
      this.commit({...current, topicSummaries: bridge.summaries,
        messages: [...bridge.messages.filter(message => message.id > bridge.newest.id), ...current.messages]});
    } else if (match || bridge.next === null || (last && last.id < bridge.newest.id)) {
      throw new HistoryChanged();
    } else return false;
    this.bridge = null; this.publish({catchingUp: false}); return true;
  }
  refresh() {
    return this.run(async request => {
      if (this.topics) {
        const page = await this.read(request);
        if (page) this.commit({...page, messages: [], next: null});
        return;
      }
      let reads = 0;
      if (!this.bridge) {
        const page = await this.read(request, !this.value.report && this.message !== undefined ? this.message + 1 : undefined); reads++;
        if (!page) return;
        const newest = this.value.report?.messages[0];
        if (!newest) {this.commit(page); return;}
        this.bridge = {newest, messages: page.messages, next: page.next, summaries: page.topicSummaries};
        if (this.resolveBridge()) return;
      }
      while (reads < 5 && this.bridge && this.bridge.next !== null) {
        const boundary = this.bridge.messages.at(-1);
        if (!boundary) throw new HistoryChanged();
        const page = await this.following(request, boundary); reads++;
        if (!page) return;
        this.bridge.messages.push(...page.messages); this.bridge.next = page.next;
        if (this.resolveBridge()) return;
      }
      this.publish({catchingUp: this.bridge !== null});
    });
  }
  older() {
    const before = this.value.report?.next;
    if (this.topics || before === null || before === undefined) return Promise.resolve();
    return this.run(async request => {
      const boundary = this.value.report?.messages.at(-1);
      if (!boundary || boundary.id !== before) throw new HistoryChanged();
      const page = await this.following(request, boundary), current = this.value.report;
      if (!page || !current) return;
      this.commit({...current, messages: [...current.messages, ...page.messages], next: page.next});
    });
  }
}
