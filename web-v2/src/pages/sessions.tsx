import {useEffect, useRef, useState} from 'react';
import {Button, Dialog, EmptyState, Field, Input, LoadingState, Notice, Page, PageHeader, Tabs} from '../design/components.js';
import {Icon} from '../design/icons.js';
import {Link, useNavigate, useSearchParams} from '../router.js';
import type {SessionHarness, LibraryAdapter, LibraryScope, SessionRef, SessionSummary, TranscriptEntry, TranscriptEvent, Visibility} from './library-types.js';
import {MetaList, OwnerControls, VisibilityBadge, When, authorName, byDay, harnessName} from './library-controls.js';
import {failureMessage, useLibraryMutation, useResource} from './use-resource.js';
import {consoleResourceKey, useConsoleModel} from '../data.tsx';

const PAGE = 50, MAX = 500;
const harnessOf = (value: string | null): SessionHarness | null => value === 'claude-code' || value === 'codex' || value === 'grok-bot' ? value : null;
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
  const model = useConsoleModel(consoleResourceKey(adapter, 'session-draft'), () => ({query, draft:query}));
  const [draft, setDraftValue] = useState(model.query === query ? model.draft : query), [page, setPage] = useState({key, limit: PAGE});
  const setDraft = (value: string) => {model.draft = value;setDraftValue(value);};
  const limit = page.key === key ? page.limit : PAGE;
  useEffect(() => {if(model.query !== query){model.query = query;model.draft = query;setDraftValue(query);}}, [model, query]);
  const {data, error, loading, retry, replace} = useResource(adapter, 'sessions/list', key, limit, signal => adapter('sessions/list', {scope, query, limit}, signal), 'Sessions could not load. Try again.');
  const mutate = useLibraryMutation(adapter);
  const [removing, setRemoving] = useState<SessionSummary | null>(null), [removal, setRemoval] = useState({busy: false, error: '', done: ''});
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function remove(session: {harness: SessionHarness; sessionId: string}) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setRemoval({busy: true, error: '', done: ''});
    try {
      const result = await mutate('sessions/delete', {harness: session.harness, sessionId: session.sessionId}, current.signal);
      if (current.signal.aborted) return;
      replace(value => value && {...value, sessions: value.sessions.filter(item => !(item.mine && item.harness === session.harness && item.sessionId === session.sessionId)),
        deletions: [...(value.deletions ?? []).filter(item => !(item.harness === session.harness && item.sessionId === session.sessionId)), ...(!result.deleted ? [session] : [])]});
      setRemoving(null); setRemoval({busy: false, error: '', done: result.deleted ? session.sessionId : ''});
    } catch (failure) {if (!current.signal.aborted) setRemoval({busy: false, error: failureMessage(failure, 'The session could not be deleted. Try again.'), done: ''});}
  }
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params); next.delete('deleted');
    for (const [name, value] of Object.entries(changes)) if (value) next.set(name, value); else next.delete(name);
    setParams(next);
  };
  return <Page title="Sessions" description="Agent sessions captured across your workspace. Private sessions are visible only to the person who captured them." bodyClassName="oc-library">
    {(params.get('deleted') === '1' || removal.done) && <Notice tone="success">Session permanently deleted from search and raw storage. Future uploads of this session will be discarded.</Notice>}
    {removal.error && !removing && <Notice tone="danger">{removal.error}</Notice>}
    {data?.deletions?.map(item => <Notice key={item.harness + ':' + item.sessionId} tone="warning">
      <p>Session {item.sessionId} is hidden from everyone. Permanent storage cleanup is pending. Retry to finish; if it stays pending, ask your instance operator to check storage access or unfinished writes.</p>
      <Button busy={removal.busy} onClick={() => void remove(item)}>Retry deletion</Button>
    </Notice>)}
    <Tabs label="Sessions shown" value={scope} onChange={value => update({scope: value === 'mine' ? 'mine' : ''})} items={[{value: 'all', label: 'All sessions'}, {value: 'mine', label: 'My sessions'}]}/>
    <form className="query-form" role="search" onSubmit={event => {event.preventDefault(); update({q: draft.trim()});}}>
      <Field label="Search sessions"><Input type="search" value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} placeholder="Search sessions…"/></Field>
      <div className="actions"><Button type="submit" variant="primary">Search</Button>{query && <Button variant="quiet" onClick={() => update({q: ''})}>Clear</Button>}</div>
    </form>
    {error && <Notice tone="danger">{error}</Notice>}
    {error && <div className="actions"><Button onClick={retry}>Try again</Button></div>}
    {!data && loading && <LoadingState label="Loading sessions"/>}
    {data && (data.sessions.length ? <ol className="oc-row-groups" aria-busy={loading || undefined}>{byDay(data.sessions, session => session.lastActivityAt).map(([day, items]) => <li key={day}>
      <h2 className="oc-row-group-label">{day}</h2>
      <ul className="oc-rows">{items.map(session => <li key={sessionPath(session)} className="oc-row-item"><Link to={sessionPath(session)} className="oc-row">
        <span className="oc-row-title"><span>{session.title}</span><VisibilityBadge value={session.private}/></span>
        <span className="oc-row-optional">{authorName(session.userId, session.mine, data.authors)}</span>
        <span className="oc-row-optional">{harnessName(session.harness)}</span>
        <span className="oc-row-end"><When value={session.lastActivityAt}/></span>
      </Link>{session.mine ? <Button variant="quiet" className="oc-icon-button oc-row-action" aria-label={`Delete session: ${session.title}`} title="Delete session" onClick={() => {setRemoval({busy: false, error: '', done: ''}); setRemoving(session);}}><Icon name="trash" size={16}/></Button> : <span className="oc-row-action" aria-hidden="true"/>}</li>)}</ul>
    </li>)}</ol> : <EmptyState title={query ? 'No matching sessions' : scope === 'mine' ? 'You have no captured sessions yet' : 'No captured sessions yet'}
      description={query ? 'Try different words, or clear the search.' : 'Sessions appear here after an agent with OpenCrawl capture finishes a turn.'}/>)}
    <Dialog open={Boolean(removing)} onClose={() => {if (!removal.busy) setRemoving(null);}} title="Delete this session?"
      description="Permanently remove this transcript, uploaded attachments, and search results for everyone. This session cannot be captured again, including from another installation. Local files on your computer are unchanged."
      actions={<><Button disabled={removal.busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" busy={removal.busy} autoFocus onClick={() => removing && void remove(removing)}>Delete session</Button></>}>
      {removal.error ? <Notice tone="danger">{removal.error}</Notice> : <p className="oc-row-dialog-title">{removing?.title}</p>}
    </Dialog>
    {data && data.sessions.length >= limit && limit < MAX && <div className="actions"><Button busy={loading} onClick={() => setPage({key, limit: limit + PAGE})}>Show more sessions</Button></div>}
  </Page>;
}

type Activity = Exclude<TranscriptEntry, {type: 'message'}>;
type Block = {kind: 'message'; key: string; role: 'user' | 'assistant'; text: string; timestamp: string | null; first: boolean} | {kind: 'activity'; key: string; entries: Activity[]};
/** Consecutive tool calls, results and notes collapse into one line between messages. */
export function transcriptBlocks(events: ReadonlyArray<TranscriptEvent>): Block[] {
  const blocks: Block[] = [];
  let role: string | null = null;
  for (const event of events) event.entries.forEach((entry, index) => {
    const key = `${event.eventId}:${index}`;
    if (entry.type === 'message') {blocks.push({kind: 'message', key, role: entry.role, text: entry.text, timestamp: event.timestamp, first: entry.role !== role}); role = entry.role; return;}
    const last = blocks.at(-1);
    if (last?.kind === 'activity') last.entries.push(entry); else blocks.push({kind: 'activity', key, entries: [entry]});
  });
  return blocks;
}
function activitySummary(entries: ReadonlyArray<Activity>) {
  const calls = entries.filter(entry => entry.type === 'tool_call').map(entry => entry.type === 'tool_call' ? entry.name : '');
  if (!calls.length) return entries.map(entry => entry.type === 'note' ? entry.label : 'Tool result').filter((value, index, all) => all.indexOf(value) === index).join(', ');
  const names = calls.filter((value, index, all) => all.indexOf(value) === index);
  return `${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}`;
}
function ActivityDetail({entry}: {entry: Activity}) {
  const label = entry.type === 'tool_call' ? <>Call <code>{entry.name}</code></> : entry.type === 'tool_result' ? 'Result' : entry.label;
  const body = entry.type === 'tool_call' ? entry.input : entry.text;
  if (!body) return <li className="muted">{label}</li>;
  return <li><details className="oc-log-tool"><summary>{label}</summary><pre className="code-block">{body}</pre>{entry.truncated && <p className="muted">Showing the first 20,000 characters.</p>}</details></li>;
}
const LONG = 1200;
function MessageText({text}: {text: string}) {
  const long = text.length > LONG || text.split('\n').length > 14;
  const [open, setOpen] = useState(false);
  return <div className="oc-log-body">
    <div className={`preserve-text oc-log-text${long && !open ? ' oc-log-clamped' : ''}`}>{text}</div>
    {long && <Button variant="quiet" className="oc-log-more" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Show less' : 'Show full message'}</Button>}
  </div>;
}
function TranscriptBlock({block, turn}: {block: Block; turn: boolean}) {
  if (block.kind === 'activity') return <li className="oc-log-activity"><span className="oc-log-gutter"/><details className="oc-log-tools"><summary>{activitySummary(block.entries)}</summary><ol>{block.entries.map((entry, index) => <ActivityDetail key={index} entry={entry}/>)}</ol></details></li>;
  return <li className={`oc-log-${block.role}${turn ? ' oc-log-turn' : ''}`}>
    <span className="oc-log-gutter">{block.first && <><strong>{block.role === 'user' ? 'User' : 'Agent'}</strong><When value={block.timestamp}/></>}</span>
    <MessageText text={block.text}/>
  </li>;
}

function SessionViewer({adapter, reference}: {adapter: LibraryAdapter; reference: SessionRef}) {
  const navigate = useNavigate();
  const {data, error, loading, retry} = useResource(adapter, 'sessions/read', sessionPath(reference), 0, signal => adapter('sessions/read', reference, signal), 'This session could not load. Try again.');
  const mutate = useLibraryMutation(adapter);
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
  const blocks = transcriptBlocks(events);
  return <div className="oc-library oc-library-viewer">
    {back}
    <PageHeader title={session.title} actions={session.mine ? <OwnerControls noun="session" visibility={current}
      onVisibility={async (value, signal) => {await mutate('sessions/visibility', {harness: session.harness, sessionId: session.sessionId, visibility: value}, signal); setVisibility(value);}}
      onDelete={async signal => {const result = await mutate('sessions/delete', {harness: session.harness, sessionId: session.sessionId}, signal); navigate(result.deleted ? '/sessions?deleted=1' : '/sessions', {replace: true});}}
      deleteDescription="Permanently remove this transcript, uploaded attachments, and search results for everyone. This session cannot be captured again, including from another installation. Local files on your computer are unchanged."/> : undefined}/>
    <MetaList items={[{label: 'Status', value: current === 'private' ? <VisibilityBadge value/> : null}, {label: 'Captured by', value: authorName(session.userId, session.mine, data.authors)}, {label: 'Agent', value: harnessName(session.harness)},
      {label: 'Origin', value: session.origin}, {label: 'Events', value: data.total.toLocaleString('en-US')}, {label: 'Session ID', value: <code>{session.sessionId}</code>}]}/>
    {current === 'private' && <Notice>Only you can see this session. Teammates and their agents cannot read or search it.</Notice>}
    {blocks.length ? <ol className="oc-log" aria-label="Transcript">{blocks.map((block, index) => <TranscriptBlock key={block.key} block={block} turn={index > 0 && block.kind === 'message' && block.role === 'user' && block.first}/>)}</ol>
      : <EmptyState title="No readable messages yet" description="This page contains only capture metadata. Load more of the session to continue."/>}
    <p className="muted" role="status">Showing {events.length.toLocaleString('en-US')} of {data.total.toLocaleString('en-US')} captured events.</p>
    {moreState.error && <Notice tone="danger">{moreState.error}</Notice>}
    {next && <div className="actions"><Button busy={moreState.busy} onClick={() => void loadMore()}>Show more of this session</Button></div>}
  </div>;
}
