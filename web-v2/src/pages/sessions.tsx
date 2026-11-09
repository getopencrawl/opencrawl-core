import {useEffect, useRef, useState} from 'react';
import {Button, EmptyState, Field, Input, LoadingState, Notice, PageHeader, Tabs} from '../design/components.js';
import {Icon} from '../design/icons.js';
import {Link, useNavigate, useSearchParams} from '../router.js';
import type {Harness, LibraryAdapter, LibraryScope, SessionRef, TranscriptEntry, TranscriptEvent, Visibility} from './library-types.js';
import {MetaList, OwnerControls, VisibilityBadge, When, authorName, harnessName} from './library-controls.js';
import {failureMessage, useResource} from './use-resource.js';

const PAGE = 50, MAX = 500;
const harnessOf = (value: string | null): Harness | null => value === 'claude-code' || value === 'codex' ? value : null;
export function sessionPath({userId, harness, sessionId}: SessionRef) {
  return '/sessions?' + new URLSearchParams({user: userId, harness, id: sessionId}).toString();
}

/** Captured agent sessions: a searchable list and a transcript viewer. */
export function SessionsPage({adapter}: {adapter: LibraryAdapter}) {
  const [params] = useSearchParams();
  const userId = params.get('user'), harness = harnessOf(params.get('harness')), sessionId = params.get('id');
  if (userId && harness && sessionId) return <SessionViewer key={sessionPath({userId, harness, sessionId})} adapter={adapter} reference={{userId, harness, sessionId}}/>;
  return <SessionList adapter={adapter}/>;
}

function SessionList({adapter}: {adapter: LibraryAdapter}) {
  const [params, setParams] = useSearchParams();
  const scope: LibraryScope = params.get('scope') === 'mine' ? 'mine' : 'all';
  const query = params.get('q')?.trim().slice(0, 500) ?? '', key = scope + '\n' + query;
  const [draft, setDraft] = useState(query), [page, setPage] = useState({key, limit: PAGE});
  const limit = page.key === key ? page.limit : PAGE;
  useEffect(() => setDraft(query), [query]);
  const {data, error, loading, retry} = useResource(key, limit, signal => adapter('sessions/list', {scope, query, limit}, signal), 'Sessions could not load. Try again.');
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params); next.delete('deleted');
    for (const [name, value] of Object.entries(changes)) if (value) next.set(name, value); else next.delete(name);
    setParams(next);
  };
  return <div className="oc-library">
    <PageHeader title="Sessions" description="Agent sessions captured across your workspace. Private sessions are visible only to the person who captured them."/>
    {params.get('deleted') === '1' && <Notice tone="success">Session deleted. It no longer appears in search for anyone.</Notice>}
    <Tabs label="Sessions shown" value={scope} onChange={value => update({scope: value === 'mine' ? 'mine' : ''})} items={[{value: 'all', label: 'All sessions'}, {value: 'mine', label: 'My sessions'}]}/>
    <form className="query-form" role="search" onSubmit={event => {event.preventDefault(); update({q: draft.trim()});}}>
      <Field label="Search sessions"><Input type="search" value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} placeholder="Words from the conversation"/></Field>
      <div className="actions"><Button type="submit" variant="primary">Search</Button>{query && <Button variant="quiet" onClick={() => update({q: ''})}>Clear</Button>}</div>
    </form>
    {error && <Notice tone="danger">{error}</Notice>}
    {error && <div className="actions"><Button onClick={retry}>Try again</Button></div>}
    {!data && loading && <LoadingState label="Loading sessions"/>}
    {data && (data.sessions.length ? <ul className="oc-library-list" aria-busy={loading || undefined}>{data.sessions.map(session => <li key={sessionPath(session)} className="oc-library-item">
      <div className="oc-library-heading"><Link to={sessionPath(session)} className="oc-library-title">{session.title}</Link><VisibilityBadge value={session.private}/></div>
      <MetaList items={[{label: 'Captured by', value: authorName(session.userId, session.mine, data.authors)}, {label: 'Agent', value: harnessName(session.harness)},
        {label: 'Last active', value: <When value={session.lastActivityAt}/>}, {label: 'Events', value: session.events.toLocaleString('en-US')}]}/>
    </li>)}</ul> : <EmptyState title={query ? 'No matching sessions' : scope === 'mine' ? 'You have no captured sessions yet' : 'No captured sessions yet'}
      description={query ? 'Try different words, or clear the search.' : 'Sessions appear here after an agent with OpenCrawl capture finishes a turn.'}/>)}
    {data && data.sessions.length >= limit && limit < MAX && <div className="actions"><Button busy={loading} onClick={() => setPage({key, limit: limit + PAGE})}>Show more sessions</Button></div>}
  </div>;
}

function TranscriptItem({entry, timestamp}: {entry: TranscriptEntry; timestamp: string | null}) {
  if (entry.type === 'message') return <article className={`oc-transcript-message oc-transcript-${entry.role}`}>
    <header><strong>{entry.role === 'user' ? 'User' : 'Agent'}</strong><When value={timestamp}/></header>
    <div className="preserve-text">{entry.text}</div>
  </article>;
  const truncated = entry.truncated && <p className="muted">Showing the first 20,000 characters.</p>;
  if (entry.type === 'tool_call') return <details className="oc-disclosure oc-transcript-tool"><summary>Tool call: <code>{entry.name}</code></summary><pre className="code-block">{entry.input}</pre>{truncated}</details>;
  if (entry.type === 'tool_result') return <details className="oc-disclosure oc-transcript-tool"><summary>Tool result</summary><pre className="code-block">{entry.text || 'No output.'}</pre>{truncated}</details>;
  return entry.text ? <details className="oc-disclosure oc-transcript-tool"><summary>{entry.label}</summary><pre className="code-block">{entry.text}</pre>{truncated}</details> : <p className="oc-transcript-note muted">{entry.label}</p>;
}

function SessionViewer({adapter, reference}: {adapter: LibraryAdapter; reference: SessionRef}) {
  const navigate = useNavigate();
  const {data, error, loading, retry} = useResource(sessionPath(reference), 0, signal => adapter('sessions/read', reference, signal), 'This session could not load. Try again.');
  const [more, setMore] = useState<{events: TranscriptEvent[]; next: string | null} | null>(null);
  const [moreState, setMoreState] = useState({busy: false, error: ''}), [visibility, setVisibility] = useState<Visibility | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const events = [...data?.events ?? [], ...more?.events ?? []], next = more ? more.next : data?.next ?? null;
  async function loadMore() {
    if (!next) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setMoreState({busy: true, error: ''});
    try {
      const page = await adapter('sessions/read', {...reference, cursor: next}, current.signal);
      if (!current.signal.aborted) {setMore(value => ({events: [...value?.events ?? [], ...page.events], next: page.next})); setMoreState({busy: false, error: ''});}
    } catch (failure) {if (!current.signal.aborted) setMoreState({busy: false, error: failureMessage(failure, 'More of this session could not load. Try again.')});}
  }
  const back = <Link to="/sessions" className="oc-library-back"><Icon name="arrow-left"/>All sessions</Link>;
  if (!data) return <div className="oc-library">{back}<PageHeader title="Session"/>{loading ? <LoadingState label="Loading session"/> : <>
    <Notice tone="danger">{error}</Notice><div className="actions"><Button onClick={retry}>Try again</Button></div></>}</div>;
  const {session} = data, current: Visibility = visibility ?? (session.private ? 'private' : 'team');
  const prompt = events.flatMap(event => event.entries).find(entry => entry.type === 'message' && entry.role === 'user');
  const title = prompt?.type === 'message' ? prompt.text.replace(/\s+/g, ' ').trim().slice(0, 140) : `Session ${session.sessionId}`;
  const visible = events.filter(event => event.entries.length);
  return <div className="oc-library oc-library-viewer">
    {back}
    <PageHeader title={title}/>
    <div className="oc-library-heading"><VisibilityBadge value={current === 'private'}/></div>
    <MetaList items={[{label: 'Captured by', value: authorName(session.userId, session.mine, data.authors)}, {label: 'Agent', value: harnessName(session.harness)},
      {label: 'Origin', value: session.origin}, {label: 'Session ID', value: <code>{session.sessionId}</code>}]}/>
    {session.mine && <OwnerControls noun="session" visibility={current}
      onVisibility={async (value, signal) => {await adapter('sessions/visibility', {harness: session.harness, sessionId: session.sessionId, visibility: value}, signal); setVisibility(value);}}
      onDelete={async signal => {await adapter('sessions/delete', {harness: session.harness, sessionId: session.sessionId}, signal); navigate('/sessions?deleted=1', {replace: true});}}
      deleteDescription="OpenCrawl permanently removes this transcript and its search results for everyone in the workspace. If the session is still running, its new activity is discarded."/>}
    {current === 'private' && <Notice>Only you can see this session. Teammates and their agents cannot read or search it.</Notice>}
    {visible.length ? <ol className="oc-transcript" aria-label="Transcript">{visible.flatMap(event => event.entries.map((entry, index) => <li key={`${event.eventId}:${index}`}><TranscriptItem entry={entry} timestamp={index === 0 ? event.timestamp : null}/></li>))}</ol>
      : <EmptyState title="No readable messages yet" description="This page contains only capture metadata. Load more of the session to continue."/>}
    <p className="muted" role="status">Showing {events.length.toLocaleString('en-US')} of {data.total.toLocaleString('en-US')} captured events.</p>
    {moreState.error && <Notice tone="danger">{moreState.error}</Notice>}
    {next && <div className="actions"><Button busy={moreState.busy} onClick={() => void loadMore()}>Show more of this session</Button></div>}
  </div>;
}
