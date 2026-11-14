import {Fragment, useCallback, useLayoutEffect, useRef, type ReactNode} from 'react';
import {Button, EmptyState, LinkButton, LoadingState, Notice} from '../design/components.js';
import {agentIdentityClass} from '../design/identity.js';
import {Icon} from '../design/icons.js';
import {Link} from '../router.js';
import type {BoardMessage, BoardReport, ConsoleDataAdapter} from './types.js';
import {useBoard} from './use-board.js';

export const topicHref = (topic = '') => '/diagnostics?view=board' + (topic ? '&topic=' + encodeURIComponent(topic) : '');
const messageHref = (topic: string, id: number) => topicHref(topic) + '&message=' + id;
const day = (timestamp: number) => new Date(timestamp).toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'});
const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'});
const noCapture = () => {};

/** Summaries use a scoped reader; opening an older permalink never scans history. */
export function BoardNavigation({adapter, topic, closeNavigation}: {adapter: Pick<ConsoleDataAdapter, 'board'>; topic: string; closeNavigation: () => void}) {
  const {report, busy, error, retry} = useBoard(adapter, '', true, noCapture);
  const topics = report?.topicSummaries.map(item => item.topic) ?? [];
  if (topic && !topics.includes(topic)) topics.push(topic);
  return <>
    <div className="oc-nav-group oc-board-back"><LinkButton variant="quiet" to="/diagnostics?nav=workspace" onClick={closeNavigation}><Icon name="arrow-left"/><span>Back</span></LinkButton></div>
    <div className="oc-nav-group">
      <Link className={`oc-nav-link${!topic ? ' oc-nav-active' : ''}`} to={topicHref()} aria-current={!topic ? 'page' : undefined} onClick={closeNavigation}><Icon name="overview"/><span>All topics</span></Link>
      {topics.map(name => <Link key={name} className={`oc-nav-link${topic === name ? ' oc-nav-active' : ''}`} to={topicHref(name)} aria-current={topic === name ? 'page' : undefined} onClick={closeNavigation}><span className="oc-board-topic-mark" aria-hidden="true">#</span><span>{name}</span></Link>)}
      {!report && busy && <LoadingState label="Loading topics"/>}
      {error && <div className="oc-board-navigation-error"><Notice tone="warning">Topics couldn’t update.</Notice><Button variant="quiet" disabled={busy} onClick={() => void retry()}>Try again</Button></div>}
    </div>
  </>;
}

function MessageText({text, messages}: {text: string; messages: ReadonlyArray<BoardMessage>}) {
  const parts: ReactNode[] = [];
  const pattern = /https?:\/\/[^\s<>]+|@[a-zA-Z0-9][a-zA-Z0-9:_.-]*|(?:message\s+|#)\d{3,}/g;
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(at, match.index));
    const value = match[0];
    if (/^https?:/.test(value)) {
      const clean = value.replace(/[.,;]+$/, '');
      let safe = false;
      try {const url = new URL(clean); safe = !url.username && !url.password;} catch { /* Preserve malformed source text. */ }
      parts.push(safe ? <a key={match.index} href={clean} target="_blank" rel="noopener noreferrer">{clean}</a> : clean, value.slice(clean.length));
    } else if (value.startsWith('@')) parts.push(<span key={match.index} className="oc-board-mention">{value}</span>);
    else {
      const id = Number(value.match(/\d+/)?.[0]);
      const referenced = messages.find(message => message.id === id);
      parts.push(referenced ? <Link key={match.index} to={messageHref(referenced.topic, id)}>{value}</Link> : value);
    }
    at = match.index + value.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function messageGroups(messages: ReadonlyArray<BoardMessage>, selected?: number): BoardMessage[][] {
  const groups: BoardMessage[][] = [];
  for (const message of [...messages].sort((a, b) => a.id - b.id)) {
    const group = groups.at(-1), previous = group?.at(-1);
    if (previous && previous.agent === message.agent && previous.topic === message.topic && day(previous.timestamp) === day(message.timestamp) && message.timestamp >= previous.timestamp && message.timestamp - previous.timestamp < 300_000 && message.id !== selected) group!.push(message);
    else groups.push([message]);
  }
  return groups;
}

export function BoardContent({report, stream, message}: {report: BoardReport; stream: boolean; message?: number}) {
  if (!report.messages.length) return <EmptyState title={stream ? 'No workspace messages yet' : 'No messages in this topic yet'}/>;
  const groups = messageGroups(report.messages, message);
  return <>{groups.map((group, index) => {
    const first = group[0]!, previous = groups[index - 1]?.[0], date = day(first.timestamp);
    return <Fragment key={first.id}>
      {(!previous || date !== day(previous.timestamp)) && <div className="oc-board-date"><span>{date}</span></div>}
      <div className="oc-board-message-group">
        <header className="oc-board-post-header">
          {stream && <Link className="oc-board-message-topic" to={topicHref(first.topic)}># {first.topic}</Link>}
          <div className="oc-board-author-line"><h3 className={agentIdentityClass(first.agent)}>{first.name || first.agent}</h3><time dateTime={new Date(first.timestamp).toISOString()} title={new Date(first.timestamp).toLocaleString()}>{time(first.timestamp)}</time></div>
        </header>
        {group.map((post, offset) => <article key={post.id} className={`oc-board-post${offset ? ' continued' : ''}${message === post.id ? ' selected' : ''}`} data-board-anchor={'post:' + post.id} tabIndex={-1} aria-label={`${post.name || post.agent}, ${time(post.timestamp)}`}>
          <Link className="oc-board-post-id" to={messageHref(post.topic, post.id)} aria-label={'Permalink to message #' + post.id}>#{post.id}</Link>
          <p className="oc-board-post-body"><MessageText text={post.text} messages={report.messages}/></p>
        </article>)}
      </div>
    </Fragment>;
  })}</>;
}

export function BoardInspector({adapter, stream, topic, message}: {adapter: Pick<ConsoleDataAdapter, 'board'>; stream: boolean; topic: string; message?: number}) {
  const root = useRef<HTMLDivElement>(null), located = useRef(false), opened = useRef(false);
  const anchor = useRef<{key: string; top: number} | 'latest' | null>(null);
  const capture = useCallback(() => {
    anchor.current = null;
    const viewport = root.current;
    if (!viewport) return;
    if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24 && message === undefined) {anchor.current = 'latest'; return;}
    const edge = viewport.getBoundingClientRect().top + (viewport.querySelector('.oc-board-date')?.getBoundingClientRect().height ?? 0);
    const first = Array.from(viewport.querySelectorAll<HTMLElement>('[data-board-anchor]')).find(element => element.getBoundingClientRect().bottom > edge);
    if (first?.dataset.boardAnchor) anchor.current = {key: first.dataset.boardAnchor, top: first.getBoundingClientRect().top};
  }, [message]);
  const {report, busy, error, catchingUp, retry, older} = useBoard(adapter, topic, false, capture, message);
  useLayoutEffect(() => {
    const restoration = history.scrollRestoration;
    history.scrollRestoration = 'manual';
    return () => {history.scrollRestoration = restoration;};
  }, []);
  useLayoutEffect(() => {
    const viewport = root.current, saved = anchor.current; anchor.current = null;
    if (!viewport || !report) return;
    if (message !== undefined && !located.current && !error) {
      const post = viewport.querySelector<HTMLElement>('[data-board-anchor="post:' + message + '"]');
      if (post) {located.current = true; opened.current = true; post.focus({preventScroll: true}); post.scrollIntoView({block: 'center'});}
      return;
    }
    if (!opened.current && message === undefined && report.messages.length) {
      const showRecent = () => {
        viewport.scrollTop = viewport.scrollHeight;
        const edge = viewport.getBoundingClientRect().top + (viewport.querySelector('.oc-board-date')?.getBoundingClientRect().height ?? 0);
        const group = Array.from(viewport.querySelectorAll<HTMLElement>('.oc-board-message-group')).find(item => item.getBoundingClientRect().bottom > edge);
        if (group) viewport.scrollTop += group.getBoundingClientRect().top - edge;
        return viewport.scrollTop;
      };
      opened.current = true;
      const initial = showRecent(); let cancelled = false;
      void document.fonts.ready.then(() => {if (!cancelled && viewport.scrollTop === initial) showRecent();});
      return () => {cancelled = true;};
    }
    if (saved === 'latest') viewport.scrollTop = viewport.scrollHeight;
    else if (saved) {
      const post = Array.from(viewport.querySelectorAll<HTMLElement>('[data-board-anchor]')).find(item => item.dataset.boardAnchor === saved.key);
      if (post) viewport.scrollTop += post.getBoundingClientRect().top - saved.top;
    }
  }, [report, error, catchingUp, message]);
  return <section className="oc-board-conversation" aria-label={topic ? '# ' + topic : 'All topics'}>
    <div className="oc-board-stream" ref={root} tabIndex={0} aria-label="Messages" aria-busy={busy}>
      {report && report.next !== null && <div className="oc-board-pagination"><Button disabled={busy} onClick={() => void older()}>Load older messages</Button></div>}
      {!report && busy && <LoadingState label="Loading messages"/>}
      {error && <div className="oc-board-feedback"><Notice tone={report ? 'warning' : 'danger'}>{report ? 'Messages couldn’t update. We’ll try again automatically while you’re viewing this page.' : error}</Notice>{!report && <Button disabled={busy} onClick={() => void retry()}>Try again</Button>}</div>}
      {catchingUp && <div className="oc-board-feedback" role="status">Loading newer messages…</div>}
      {report && message !== undefined && !report.messages.some(post => post.id === message) && <Notice>Message #{message} is unavailable in this topic.</Notice>}
      {report && <BoardContent report={report} stream={stream} message={message}/>}
    </div>
  </section>;
}
