import {useCallback, useLayoutEffect, useRef} from 'react';
import {Button, EmptyState, Notice, Table} from '../design/components.js';
import {ForumPanel, ForumPost} from '../design/forum.js';
import {Link} from '../router.js';
import type {BoardReport, ConsoleDataAdapter} from './types.js';
import {useBoard} from './use-board.js';

const topicHref = (topic: string) => '/diagnostics?view=board&topic=' + encodeURIComponent(topic);
function BoardTime({timestamp}: {timestamp: number}) {
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime())) return <span>Time unavailable</span>;
  return (
    <time dateTime={value.toISOString()}>
      {value.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}
    </time>
  );
}

export function BoardContent({report, topics, stream}: {report: BoardReport; topics: boolean; stream: boolean}) {
  if (topics) {
    if (!report.topicSummaries.length) return <EmptyState title="No topics yet"/>;
    return (
      <Table label="Agent board topics" className="oc-forum-topics">
        <thead>
          <tr><th scope="col">Topic</th><th scope="col">Posts</th><th scope="col">Latest post</th></tr>
        </thead>
        <tbody>
          {report.topicSummaries.map(item => (
            <tr key={item.topic} data-board-anchor={'topic:' + item.topic}>
              <th scope="row"><Link to={topicHref(item.topic)}>{item.topic}</Link></th>
              <td>{item.posts.toLocaleString()}</td>
              <td>
                <div className="oc-forum-latest">
                  <BoardTime timestamp={item.latest.timestamp}/>
                  <span>{item.latest.name}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    );
  }
  if (!report.messages.length) {
    return <EmptyState title={stream ? 'No workspace messages yet' : 'No messages in this topic yet'}/>;
  }
  return (
    <>
      <div className="oc-forum-columns" aria-hidden="true"><span>Author</span><span>Message</span></div>
      {report.messages.map(message => (
        <ForumPost
          key={message.id}
          anchor={'post:' + message.id}
          author={message.name || message.agent}
          title={stream ? <Link to={topicHref(message.topic)}>{message.topic}</Link> : undefined}
          metadata={<><BoardTime timestamp={message.timestamp}/><span>#{message.id}</span></>}
        >
          <p>{message.text}</p>
        </ForumPost>
      ))}
    </>
  );
}

export function BoardInspector({adapter, stream, topic}: {adapter: Pick<ConsoleDataAdapter, 'board'>; stream: boolean; topic: string}) {
  const root = useRef<HTMLElement>(null);
  const anchor = useRef<{key: string; top: number} | null>(null);
  const capture = useCallback(() => {
    anchor.current = null;
    const panel = root.current;
    if (!panel) return;
    const edge = Number.parseFloat(getComputedStyle(panel).scrollMarginTop) || 0;
    if (panel.getBoundingClientRect().top >= edge) return;
    const posts = Array.from(panel.querySelectorAll<HTMLElement>('[data-board-anchor]'));
    // At the beginning, let new posts appear naturally instead of pushing the reader down.
    if (!posts.length || posts[0]!.getBoundingClientRect().top >= edge) return;
    const first = posts.find(element => element.getBoundingClientRect().bottom > edge);
    if (first?.dataset.boardAnchor) anchor.current = {key: first.dataset.boardAnchor, top: first.getBoundingClientRect().top};
  }, []);
  const topics = !stream && !topic;
  const {report, busy, error, catchingUp, retry, older} = useBoard(adapter, topic, topics, capture);
  useLayoutEffect(() => {
    const saved = anchor.current; anchor.current = null;
    if (!saved || !root.current) return;
    const element = Array.from(root.current.querySelectorAll<HTMLElement>('[data-board-anchor]')).find(item => item.dataset.boardAnchor === saved.key);
    if (element) window.scrollBy(0, element.getBoundingClientRect().top - saved.top);
  }, [report, error, catchingUp]);
  const count = report ? topics ? report.topicSummaries.length : report.messages.length : null;
  const noun = topics ? 'topic' : 'message';
  const status = count === null ? busy ? `Loading ${noun}s…` : 'Could not load ' + noun + 's.' : `${topics ? '' : 'Showing '}${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}${catchingUp ? '. Loading newer messages…' : ''}`;
  return (
    <ForumPanel
      ref={root}
      title={topic || (stream ? 'Global stream' : 'Message board')}
      busy={busy}
      breadcrumb={topic ? <Link to="/diagnostics?view=board">All topics</Link> : undefined}
      status={status}
      footer={!topics && report && report.next !== null ? (
        <Button aria-disabled={busy || undefined} onClick={() => {if (!busy) void older();}}>
          Load older messages
        </Button>
      ) : undefined}
    >
      {error && (
        <div className="oc-forum-feedback">
          <Notice tone={report ? 'warning' : 'danger'}>
            {report
              ? 'Messages couldn’t update. We’ll try again automatically while you’re viewing this page.'
              : error}
          </Notice>
          {!report && <Button disabled={busy} onClick={() => void retry()}>Try again</Button>}
        </div>
      )}
      {report && <BoardContent report={report} topics={topics} stream={stream}/>}
    </ForumPanel>
  );
}
