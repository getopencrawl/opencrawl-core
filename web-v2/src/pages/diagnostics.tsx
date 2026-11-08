import {useEffect, useRef, useState} from 'react';
import type {FormEvent} from 'react';
import {Button, EmptyState, Field, Input, LoadingState, Notice, PageHeader, Section, Table, Tabs} from '../design/components.js';
import {Link, useLocation, useNavigate} from '../router.js';
import type {BoardReport, ConsoleDataAdapter, DiagnosticHit, DiagnosticSearch} from './types.js';
import {date} from './usage.js';

function text(value: unknown): string {return typeof value === 'string' ? value : '';}
export function excerpt(value: string, query: string, limit = 700) {
  const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = index >= 0 && value.length > limit ? Math.max(0, index - 140) : 0;
  return {text: value.slice(start, start + limit), leading: start > 0, trailing: start + limit < value.length};
}
export function searchGroups(data: DiagnosticSearch) {
  return [
    ...(data.sessions || []).map(session => ({label:'Agent sessions', hits:session.response.hits?.hits || [], total:session.response.hits?.total?.value, state:session.response.state})),
    ...(data.connectors ? [{label:'Connected sources', hits:(data.connectors.responses || []).flatMap(response => response.hits?.hits || []), state:data.connectors.state, truncated:data.connectors.truncated}] : []),
    ...(data.memories ? [{label:'Agent memories', hits:data.memories.hits?.hits || [], total:data.memories.hits?.total?.value, state:data.memories.state, truncated:data.memories.truncated}] : []),
  ];
}
export function JsonDisclosure({label, value}: {label: string; value: unknown}) {
  return <details className="oc-disclosure"><summary>{label}</summary><pre className="code-block" tabIndex={0} aria-label={label}>{JSON.stringify(value, null, 2)}</pre></details>;
}
function SearchHit({hit, query}: {hit: DiagnosticHit; query: string}) {
  const source = hit._source || {}, body = text(source.text), preview = excerpt(body, query);
  const title = text(source.title) || text(source.provider) || text(source.harness) || 'Indexed item';
  const timestamp = text(source.timestamp) || text(source.receivedAt);
  return <article className="data-item"><h3>{title}</h3><p className="muted">{[text(source.role),text(source.kind),timestamp ? date(timestamp) : ''].filter(Boolean).join(', ')}</p><p className="preserve-text">{body ? `${preview.leading ? '…' : ''}${preview.text}${preview.trailing ? '…' : ''}` : 'No indexed text in this item.'}</p>{(preview.leading || preview.trailing) && <details className="oc-disclosure"><summary>Read full indexed text</summary><div className="preserve-text bounded-text" tabIndex={0} role="region" aria-label="Full indexed text">{body}</div></details>}<JsonDisclosure label="Item metadata and JSON" value={hit}/></article>;
}
export function SearchInspector({adapter}: {adapter: Pick<ConsoleDataAdapter, 'search'>}) {
  const [query, setQuery] = useState(''), [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<DiagnosticSearch | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault(); const value = query.trim(); if (!value) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setResult(null); setError(''); setSubmitted(value); setBusy(true);
    try {const data = await adapter.search(value, controller.signal); if (!controller.signal.aborted) setResult(data);}
    catch (failure) {if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Search failed. Try again.');}
    finally {if (!controller.signal.aborted) setBusy(false);}
  }
  const groups = result ? searchGroups(result) : [], total = groups.reduce((sum, group) => sum + group.hits.length, 0);
  return <Section title="Inspect search" description="Run a diagnostic query against the same workspace your agents use. Inspect indexed text and raw results."><form className="query-form" onSubmit={event => void submit(event)}><Field label="Search query"><Input type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={4000} required placeholder="Search your workspace"/></Field><Button type="submit" variant="primary" busy={busy}>Run query</Button></form>{error && <Notice tone="danger">{error}</Notice>}{busy && <LoadingState label="Searching workspace"/>}{result && <><p role="status">{total} matching {total === 1 ? 'item' : 'items'}</p>{groups.filter(group => group.state === 'pending' || group.state === 'not_configured').map(group => <Notice key={group.label} tone="warning">{group.label}: {group.state === 'pending' ? 'indexing is pending' : 'not configured'}. Results may be incomplete.</Notice>)}{!total && <EmptyState title="No matching items" description="Try another query, or check source sync status."/>}{groups.filter(group => group.hits.length).map((group, index) => <Section key={index} title={`${group.label} (${group.hits.length})`}><div className="data-list">{group.hits.map((hit, position) => <SearchHit key={hit._id || position} hit={hit} query={submitted}/>)}</div>{'truncated' in group && group.truncated && <Notice>More results may be available. Narrow your query.</Notice>}</Section>)}<JsonDisclosure label="Raw search response" value={result}/></>}</Section>;
}
function BoardInspector({adapter, stream, topic}: {adapter: ConsoleDataAdapter; stream: boolean; topic: string}) {
  const [data, setData] = useState<BoardReport | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision,setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const topics = !stream && !topic;
  async function load(before?: number) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(''); if (!before) setData(null);
    try {const result = await adapter.board({...topic ? {topic} : {}, ...before ? {before} : {}},controller.signal);
      if (!controller.signal.aborted) setData(previous => before && previous ? {...result,messages:[...previous.messages,...result.messages]} : result);
    } catch (failure) {if (!controller.signal.aborted) {setData(null); setError(failure instanceof Error ? failure.message : 'Messages could not load. Refresh to try again.');}}
    finally {if (!controller.signal.aborted) setBusy(false);}
  }
  useEffect(() => {void load(); return () => request.current?.abort();}, [adapter,stream,topic,revision]);
  return <Section title={topic || (stream ? 'Global stream' : 'Message board')} description={topics ? 'Browse the topics your agents use to coordinate work.' : 'Read the workspace’s agent coordination messages.'} actions={<Button onClick={() => setRevision(value => value + 1)} disabled={busy}>Refresh</Button>}>{topic && <Link to="/diagnostics?view=board">All topics</Link>}{error && <Notice tone="danger">{error}</Notice>}{busy && !data && <LoadingState label="Loading messages"/>}{data && <>{topics ? data.topicSummaries.length ? <Table label="Agent board topics"><thead><tr><th scope="col">Topic</th><th scope="col">Posts</th><th scope="col">Latest activity</th></tr></thead><tbody>{data.topicSummaries.map(item => <tr key={item.topic}><th scope="row"><Link to={'/diagnostics?view=board&topic=' + encodeURIComponent(item.topic)}>{item.topic}</Link></th><td>{item.posts}</td><td>{date(item.latest.timestamp)}<span className="muted block">{item.latest.name}</span></td></tr>)}</tbody></Table> : <EmptyState title="No topics yet" description="Topics appear when your agents post coordination messages."/> : <><div className="data-list">{data.messages.map(message => <article className="data-item" key={message.id}>{stream && <h3><Link to={'/diagnostics?view=board&topic=' + encodeURIComponent(message.topic)}>{message.topic}</Link></h3>}<p className="muted">{message.name || message.agent}, {date(message.timestamp)} (#{message.id})</p><p className="preserve-text">{message.text}</p></article>)}</div>{!data.messages.length && <EmptyState title="No messages yet" description="Messages from your agents will appear here."/>}{data.next !== null && <Button onClick={() => void load(data.next ?? undefined)} busy={busy}>Load older messages</Button>}</>}</>}</Section>;
}
export function DiagnosticsPage({adapter, canInspect}: {adapter: ConsoleDataAdapter; canInspect: boolean}) {
  const location = useLocation(), navigate = useNavigate(), query = new URLSearchParams(location.search);
  const view = ['search','board','stream'].includes(query.get('view') || '') ? query.get('view')! : 'search';
  return <><PageHeader variant="report" title="Diagnostics" description="See what your agents can retrieve and how they coordinate work."/>{!canInspect ? <Notice>Workspace admins can inspect raw search results and agent messages. Ask an admin for access.</Notice> : <><Tabs label="Diagnostics views" value={view} onChange={value => navigate('/diagnostics?view=' + value)} items={[{value:'search',label:'Search inspector'},{value:'board',label:'Topics'},{value:'stream',label:'Global stream'}]}/>{view === 'search' ? <SearchInspector adapter={adapter}/> : <BoardInspector adapter={adapter} stream={view === 'stream'} topic={query.get('topic') || ''}/>}</>}</>;
}
