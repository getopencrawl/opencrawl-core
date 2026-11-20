import {useEffect, useRef, useState} from 'react';
import {Button, Dialog, EmptyState, Field, Input, LoadingState, Notice, Page, PageHeader, ScrollControl} from '../design/components.js';
import {Markdown} from '../design/markdown.js';
import {Icon} from '../design/icons.js';
import {Link, useNavigate, useSearchParams} from '../router.js';
import type {SessionHarness, SessionHosts, LibraryAdapter, LibraryScope, SessionRef, SessionSummary, TranscriptEntry, TranscriptEvent, SessionTranscript, Visibility} from './library-types.js';
import {MetaList, OwnerControls, VisibilityBadge, When, authorName, byDay, harnessName} from './library-controls.js';
import {failureMessage, failureStatus, useLibraryMutation, useResource} from './use-resource.js';
import {consoleResourceKey, useConsoleAccessFailure, useConsoleModel} from '../data.tsx';

const PAGE = 50, MAX = 500;
export const sessionHarness = (value: string | null): SessionHarness | null => value === 'claude-code' || value === 'codex' || value === 'cursor' || value === 'grok-bot' || value === 'antigravity' || value === 'replicas' || value === 'devin' ? value : null;
export function sessionPath({userId, harness, sessionId}: SessionRef) {
  return '/sessions?' + new URLSearchParams({user: userId, harness, id: sessionId}).toString();
}

function CaptureHostname({session, expanded = false}: {session: SessionHosts; expanded?: boolean}) {
  const hosts = session.hosts ?? (session.host ? [session.host] : []);
  const multiple = hosts.length > 1 || session.hostsTruncated;
  const names = hosts.join(', ') + (session.hostsTruncated ? ', …' : '');
  const label = expanded ? names || '—' : multiple ? 'Multiple hosts' : hosts[0] || '—';
  const description = hosts.length ? `Captured on: ${names}. Imported history may have originated elsewhere.` : 'Capture hostname was not recorded.';
  return <span className={expanded ? undefined : 'oc-row-host'} title={description} aria-label={`Hostname: ${names || 'not recorded'}`}>
    {!expanded && <span className="oc-row-host-label" aria-hidden="true">Hostname: </span>}{label}
  </span>;
}

const compactTokens = new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 1});
function CapturedTokens({value}: {value?: number | null}) {
  const known = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const description = known
    ? `${value.toLocaleString('en-US')} captured tokens. Message text and tool inputs/results, counted once with o200k_base. Includes imported history. Model usage and billing are separate.`
    : 'Captured token count is not available yet.';
  return <span className="oc-row-tokens" title={description} aria-label={description}>
    {known ? compactTokens.format(value).replace('K', 'k') : '—'}<span className="oc-row-tokens-label"> tokens</span>
  </span>;
}

/** Captured agent sessions: a searchable list and a transcript viewer. */
export function SessionsPage({adapter}: {adapter: LibraryAdapter}) {
  const [params] = useSearchParams();
  const userId = params.get('user'), harness = sessionHarness(params.get('harness')), sessionId = params.get('id');
  if (userId && harness && sessionId) return <SessionViewer key={consoleResourceKey(adapter).join(':') + sessionPath({userId, harness, sessionId})} adapter={adapter} reference={{userId, harness, sessionId}}/>;
  return <SessionList adapter={adapter}/>;
}

function SessionList({adapter}: {adapter: LibraryAdapter}) {
  const [params, setParams] = useSearchParams();
  const scope: LibraryScope = params.get('scope') === 'mine' ? 'mine' : 'all';
  const participant = params.get('participant') || undefined;
  const query = params.get('q')?.trim().slice(0, 500) ?? '', key = scope + '\n' + query + '\n' + (participant ?? '');
  const model = useConsoleModel(consoleResourceKey(adapter, 'session-draft'), () => ({query, draft:query}));
  const [draft, setDraftValue] = useState(model.query === query ? model.draft : query), [page, setPage] = useState({key, limit: PAGE});
  const setDraft = (value: string) => {model.draft = value;setDraftValue(value);};
  const limit = page.key === key ? page.limit : PAGE;
  useEffect(() => {if(model.query !== query){model.query = query;model.draft = query;setDraftValue(query);}}, [model, query]);
  const {data, error, loading, retry, replace} = useResource(adapter, 'sessions/list', key, limit, signal => adapter('sessions/list', {scope, query, ...(participant ? {participant} : {}), limit}, signal), 'Sessions could not load. Try again.');
  const mutate = useLibraryMutation(adapter);
  const [removing, setRemoving] = useState<SessionSummary | null>(null), [removal, setRemoval] = useState({busy: false, error: ''});
  const controller = useRef<AbortController | null>(null);
  const visibilityController = useRef<AbortController | null>(null);
  const [visibilityChange, setVisibilityChange] = useState({session: '', error: ''});
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    setVisibilityChange({session: '', error: ''});
    return () => {visibilityController.current?.abort(); visibilityController.current = null;};
  }, [adapter]);
  async function toggleVisibility(session: SessionSummary) {
    if (visibilityController.current || removal.busy) return;
    const current = new AbortController(); visibilityController.current = current;
    setVisibilityChange({session: sessionPath(session), error: ''});
    try {
      const result = await mutate('sessions/visibility', {harness: session.harness, sessionId: session.sessionId, visibility: session.private ? 'team' : 'private'}, current.signal);
      if (current.signal.aborted) return;
      replace(value => value && {...value, sessions: value.sessions.map(item => sessionPath(item) === sessionPath(session) ? {...item, private: result.visibility === 'private'} : item)});
      setVisibilityChange({session: '', error: ''});
    } catch (failure) {
      if (!current.signal.aborted) setVisibilityChange({session: '', error: `Could not update visibility for “${session.title}”. ${failureMessage(failure, 'Try again.')}`});
    } finally {if (visibilityController.current === current) visibilityController.current = null;}
  }
  async function remove(session: {harness: SessionHarness; sessionId: string}) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setRemoval({busy: true, error: ''});
    try {
      await mutate('sessions/delete', {harness: session.harness, sessionId: session.sessionId}, current.signal);
      if (current.signal.aborted) return;
      replace(value => value && {...value, sessions: value.sessions.filter(item => !(item.mine && item.harness === session.harness && item.sessionId === session.sessionId))});
      setRemoving(null); setRemoval({busy: false, error: ''});
    } catch (failure) {if (!current.signal.aborted) setRemoval({busy: false, error: failureMessage(failure, 'The session could not be deleted. Try again.')});}
  }
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params); next.delete('deleted');
    for (const [name, value] of Object.entries(changes)) if (value) next.set(name, value); else next.delete(name);
    setParams(next);
  };
  const people = (session: SessionSummary) => session.participants ?? (session.userId.startsWith('workload_replicas_') ? [] : [{id: 'user:' + session.userId}]);
  const personName = (person: {id: string; name?: string}) => person.name || (person.id.startsWith('user:')
    ? authorName(person.id.slice(5), Boolean(data?.sessions.some(session => session.mine && session.userId === person.id.slice(5))), data?.authors) : person.id.slice(9));
  const filterName = participant ? params.get('participantName') || personName(data?.sessions.flatMap(people).find(person => person.id === participant) ?? {id: participant}) : '';
  const personPath = (person: {id: string; name?: string}) => {
    const next = new URLSearchParams(params); next.delete('scope'); next.delete('deleted');
    next.set('participant', person.id); next.set('participantName', personName(person));
    return '/sessions?' + next.toString();
  };
  return <Page title="Sessions" description="Agent sessions captured across your workspace. Private sessions are visible only to the person who captured them." bodyClassName="oc-library">
    {removal.error && !removing && <Notice tone="danger">{removal.error}</Notice>}
    {visibilityChange.error && <Notice tone="danger">{visibilityChange.error}</Notice>}
    <form className="query-form" role="search" onSubmit={event => {event.preventDefault(); update({q: draft.trim()});}}>
      <Field label="Search sessions"><Input type="search" value={draft} maxLength={500} onChange={event => setDraft(event.target.value)} placeholder="Search sessions…"/></Field>
      <div className="actions"><Button type="submit" variant="primary">Search</Button>{query && <Button variant="quiet" onClick={() => update({q: ''})}>Clear</Button>}</div>
    </form>
    {(participant || scope === 'mine') && <div className="oc-filter-chips" aria-label="Session filters"><Button variant="quiet" className="oc-filter-chip"
      aria-label={`Remove participant filter: ${participant ? filterName : 'You'}`} onClick={() => update({participant: '', participantName: '', scope: ''})}>
      <Icon name="team" size={14}/><span>Participant: {participant ? filterName : 'You'}</span><Icon name="close" size={14}/>
    </Button></div>}
    {error && <Notice tone="danger">{error}</Notice>}
    {error && <div className="actions"><Button onClick={retry}>Try again</Button></div>}
    {!data && loading && <LoadingState label="Loading sessions"/>}
    {data && (data.sessions.length ? <><div className="oc-row-item oc-row-heading" aria-hidden="true"><div className="oc-row oc-row-with-host"><span>Session</span><span className="oc-row-participants">Participants</span><span className="oc-row-optional">Agent</span><span className="oc-row-host" title="The machine that captured the transcript. Imported history may have originated elsewhere.">Hostname</span><span className="oc-row-tokens">Captured tokens</span><span className="oc-row-end">Updated</span></div><span className="oc-row-actions"><span className="oc-row-visibility"/><span className="oc-row-action"/></span></div>
    <ol className="oc-row-groups" aria-busy={loading || undefined}>{byDay(data.sessions, session => session.lastActivityAt).map(([day, items]) => <li key={day}>
      <h2 className="oc-row-group-label">{day}</h2>
      <ul className="oc-rows">{items.map(session => <li key={sessionPath(session)} className="oc-row-item"><div className="oc-row oc-row-with-host">
        {session.historyCapture?<div className="oc-session-captures"><Link to={sessionPath(session)} className="oc-row-title"><span>{session.title}</span><VisibilityBadge value={session.private}/></Link>
          <Link to={sessionPath(session.historyCapture)}>Replicas history</Link></div>:
          <Link to={sessionPath(session)} className="oc-row-title"><span>{session.title}</span><VisibilityBadge value={session.private}/></Link>}
        <span className="oc-row-participants">{people(session).length ? people(session).map(person => <Link key={person.id} to={personPath(person)} title={`Show sessions with ${personName(person)}`}>{personName(person)}</Link>) : <span className="muted">Unknown</span>}{session.participantsTruncated && <span title="Additional participants are not shown">…</span>}</span>
        <span className="oc-row-optional">{harnessName(session.harness)}</span>
        <CaptureHostname session={session}/>
        <CapturedTokens value={session.capturedTokens}/>
        <span className="oc-row-end"><When value={session.lastActivityAt}/></span>
      </div><span className="oc-row-actions">
        {session.mine ? <Button variant="quiet" className="oc-icon-button oc-row-visibility"
          aria-label={`Share session with team: ${session.title}`} aria-pressed={!session.private}
          title={session.private ? 'Private. Share with team' : 'Shared with team. Make private'}
          busy={visibilityChange.session === sessionPath(session)} disabled={Boolean(visibilityChange.session) || removal.busy}
          onClick={() => void toggleVisibility(session)}>{visibilityChange.session !== sessionPath(session) && <Icon name={session.private ? 'eye-off' : 'eye'} size={18}/>}</Button> : <span className="oc-row-visibility"/>}
        {session.mine ? <Button variant="quiet" className="oc-icon-button oc-row-action" disabled={Boolean(visibilityChange.session)} aria-label={`Delete session: ${session.title}`} title="Delete session" onClick={() => {setRemoval({busy: false, error: ''}); setRemoving(session);}}><Icon name="trash" size={16}/></Button> : <span className="oc-row-action" aria-hidden="true"/>}
      </span></li>)}</ul>
    </li>)}</ol></> : <EmptyState title={query || participant ? 'No matching sessions' : scope === 'mine' ? 'You have no captured sessions yet' : 'No captured sessions yet'}
      description={query || participant ? 'Try different words, or remove a filter.' : 'Sessions appear here after an agent with OpenCrawl capture finishes a turn.'}/>)}
    <Dialog open={Boolean(removing)} onClose={() => {if (!removal.busy) setRemoving(null);}} title="Delete this session?"
      description="Permanently remove this transcript, uploaded attachments, and search results for everyone. This session cannot be captured again, including from another installation. Local files on your computer are unchanged."
      actions={<><Button disabled={removal.busy} onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" busy={removal.busy} autoFocus onClick={() => removing && void remove(removing)}>Delete session</Button></>}>
      {removal.error ? <Notice tone="danger">{removal.error}</Notice> : <p className="oc-row-dialog-title">{removing?.title}</p>}
    </Dialog>
    {data && data.sessions.length >= limit && limit < MAX && <div className="actions"><Button busy={loading} onClick={() => setPage({key, limit: limit + PAGE})}>Show more sessions</Button></div>}
  </Page>;
}

type Activity = Exclude<TranscriptEntry, {type: 'message'}>;
interface ActivityEvent {eventId: string; kind: string; timestamp: string | null; entries: Activity[];raw?:unknown}
type Block = {kind: 'message'; key: string; role: 'user' | 'assistant'; text: string; timestamp: string | null; actor?: TranscriptEvent['actor']}
  | {kind: 'activity'; key: string; events: ActivityEvent[]};
/** Keep source events, including empty records, while rendering normalized entries. */
export function transcriptBlocks(events: ReadonlyArray<TranscriptEvent>): Block[] {
  const blocks: Block[] = [];
  const activity = (event: TranscriptEvent, entries: Activity[], key: string) => {
    let block = blocks.at(-1);
    if (block?.kind !== 'activity') {block = {kind: 'activity', key, events: []}; blocks.push(block);}
    const previous = block.events.at(-1);
    if (previous?.eventId === event.eventId) previous.entries.push(...entries);
    else block.events.push({eventId: event.eventId, kind: event.kind, timestamp: event.timestamp, entries: [...entries],...(event.raw!==undefined?{raw:event.raw}:{})});
  };
  for (const event of events) {
    if (!event.entries.length) activity(event, [], event.eventId);
    event.entries.forEach((entry, index) => {
      const key = `${event.eventId}:${index}`;
      if (entry.type === 'message') blocks.push({kind: 'message', key, role: entry.role, text: entry.text, timestamp: event.timestamp,
        ...(entry.role === 'user' && event.actor ? {actor: event.actor} : {})});
      else activity(event, [entry], key);
    });
  }
  return blocks;
}
export function capturedSender(actor: TranscriptEvent['actor'], fallback: string) {
  if (!actor) return fallback;
  if (actor.kind !== 'human') return 'Unknown sender';
  return actor.name || actor.email || actor.userId || 'Unknown sender';
}
const dateLabel = (value: string | null, long = false) => value ? new Date(value).toLocaleDateString(undefined, {month: long ? 'long' : 'short', day: 'numeric', year: 'numeric'}) : '';
const timeLabel = (value: string | null) => value ? new Date(value).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}) : '';
const fullTime = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not recorded';
function ActivityDetail({entry}: {entry: Activity}) {
  const label = entry.type === 'tool_call' ? <>Call <code>{entry.name}</code></> : entry.type === 'tool_result' ? 'Result' : entry.label;
  return <div className="oc-session-entry"><span>{label}</span><pre className="code-block">{entry.type === 'tool_call' ? entry.input : entry.text}</pre>
    {entry.truncated && <p className="muted">This entry was truncated by the transcript API.</p>}</div>;
}
function TranscriptBlock({block, agent, user}: {block: Block; agent: string; user: string}) {
  const [copyState, setCopyState] = useState('');
  useEffect(() => {if (copyState) {const timer = setTimeout(() => setCopyState(''), 1800); return () => clearTimeout(timer);}}, [copyState]);
  if (block.kind === 'activity') {
    const count = new Set(block.events.map(event => event.eventId)).size;
    return <li className="oc-log-activity"><details className="oc-log-tools"><summary><Icon name="chevron-right" size={14}/>{count} {count === 1 ? 'event' : 'events'}</summary>
      <ol>{block.events.map(event => <li key={event.eventId}><details className="oc-log-tool"><summary><Icon name="chevron-right" size={12}/><code>{event.kind}</code>{event.timestamp && <time dateTime={event.timestamp}>{timeLabel(event.timestamp)}</time>}</summary>
        {event.entries.length ? event.entries.map((entry, index) => <ActivityDetail key={index} entry={entry}/>) : <p className="muted">No displayable content in this event.</p>}
        {event.raw!==undefined&&<details><summary>Original Replicas record</summary><pre className="code-block">{JSON.stringify(event.raw,null,2)}</pre></details>}
      </details></li>)}</ol></details></li>;
  }
  const name = block.role === 'assistant' ? agent : capturedSender(block.actor, user);
  const meta = <div className="oc-log-gutter"><strong title={block.actor ? `Replicas sender reported by capture${block.actor.email ? ': ' + block.actor.email : ''}` : undefined}>{name}</strong>
    {block.timestamp && <time dateTime={block.timestamp} title={fullTime(block.timestamp)}>{timeLabel(block.timestamp)}</time>}
    <Button variant="quiet" className="oc-icon-button oc-session-copy" title={copyState || 'Copy message'} aria-label={copyState || 'Copy message'} onClick={async () => {
      try {await navigator.clipboard.writeText(block.text); setCopyState('Copied message');} catch {setCopyState('Could not copy message');}
    }}><Icon name={copyState === 'Copied message' ? 'check' : 'copy'} size={13}/></Button></div>;
  return <li className={`oc-log-${block.role}`} aria-label={`${name} message`}>
    {block.role === 'user' && meta}<div className="oc-log-body"><Markdown mode="transcript">{block.text}</Markdown></div>{block.role === 'assistant' && meta}
  </li>;
}

function SessionViewer({adapter, reference}: {adapter: LibraryAdapter; reference: SessionRef}) {
  const navigate = useNavigate(), deny = useConsoleAccessFailure();
  const {data: loaded, error, loading, retry, replace} = useResource(adapter, 'sessions/read', sessionPath(reference), 0, signal => adapter('sessions/read', reference, signal), 'This session could not load. Try again.');
  const mutate = useLibraryMutation(adapter);
  const [more, setMore] = useState<{events: TranscriptEvent[]; next: string | null; total: number} | null>(null);
  const [moreState, setMoreState] = useState({busy: false, error: ''}), [visibility, setVisibility] = useState<Visibility | null>(null);
  const [details, setDetails] = useState(false), [readFailure, setReadFailure] = useState('');
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const reader = useRef<HTMLDivElement>(null), transcript = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null), end = useRef<HTMLDivElement>(null), panelHeading = useRef<HTMLHeadingElement>(null), info = useRef<HTMLButtonElement>(null), jumpPending = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {if (details) panelHeading.current?.focus();}, [details]);
  const data = readFailure ? null : loaded;
  const events = [...new Map([...data?.events ?? [], ...(data ? more?.events ?? [] : [])].map(event => [event.eventId, event])).values()];
  const next = data ? more ? more.next : data.next : null;
  const transcriptVisible = Boolean(data);
  useEffect(() => {
    const viewport = reader.current, content = transcript.current;
    if (!viewport || !content) return;
    const measure = () => setAwayFromBottom(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 200);
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(content);
    viewport.addEventListener('scroll', measure, {passive: true}); measure();
    return () => {observer.disconnect(); viewport.removeEventListener('scroll', measure);};
  }, [transcriptVisible]);
  useEffect(() => {if (jumpPending.current && !moreState.busy && !next) {end.current?.scrollIntoView({behavior: 'instant', block: 'end'}); jumpPending.current = false;}}, [events.length, next, moreState.busy]);
  async function loadMore(all = false) {
    if (!next || controller.current) return;
    const current = new AbortController(); controller.current = current;
    setMoreState({busy: true, error: ''});
    let cursor: string | null = next, collected = more?.events ?? [];
    const seen = new Set<string>();
    try {
      do {
        if (seen.has(cursor)) throw new Error('The next transcript page repeated. Try again.');
        seen.add(cursor);
        const page: SessionTranscript = await adapter('sessions/read', {...reference, cursor}, current.signal);
        if (current.signal.aborted) return;
        collected = [...new Map([...collected, ...page.events].map(event => [event.eventId, event])).values()];
        setMore({events: collected, next: page.next, total: page.total}); cursor = page.next;
      } while (all && cursor);
      setMoreState({busy: false, error: ''});
    } catch (failure) {
      if (!current.signal.aborted) {
        jumpPending.current = false;
        const message = failureMessage(failure, 'More of this session could not load. Try again.');
        if (failureStatus(failure) === undefined || (failureStatus(failure) ?? 0) < 500) {
          setMore(null); setReadFailure(message);
          if ([401, 402, 403].includes(failureStatus(failure) ?? 0)) deny?.(failure);
        }
        setMoreState({busy: false, error: message});
      }
    } finally {if (controller.current === current) controller.current = null;}
  }
  async function retryTranscript() {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    jumpPending.current = false; setMore(null); setMoreState({busy: true, error: ''});
    try {
      const page = await adapter('sessions/read', reference, current.signal);
      if (!current.signal.aborted) {replace(() => page); setReadFailure(''); setMoreState({busy: false, error: ''});}
    } catch (failure) {
      if (!current.signal.aborted) {
        setReadFailure(failureMessage(failure, 'This session could not load. Try again.'));
        setMoreState({busy: false, error: ''});
        if ([401, 402, 403].includes(failureStatus(failure) ?? 0)) deny?.(failure);
      }
    } finally {if (controller.current === current) controller.current = null;}
  }
  const closeDetails = () => {setDetails(false); info.current?.focus();};
  const back = <Link to="/sessions" className="oc-session-back" aria-label="Back to sessions" title="Back to sessions"><Icon name="arrow-left" size={18}/></Link>;
  if (!data) return <div className="oc-session-viewer"><header className="oc-session-header">{back}<PageHeader title="Session"/></header><div className="oc-session-loading">{loading ? <LoadingState label="Loading session"/> : <>
    <Notice tone="danger">{readFailure || error}</Notice>{<div className="actions"><Button busy={moreState.busy} onClick={readFailure ? () => void retryTranscript() : retry}>Try again</Button></div>}</>}</div></div>;
  const {session} = data, current: Visibility = visibility ?? (session.private ? 'private' : 'team');
  const first = events.find(event => event.timestamp)?.timestamp ?? null, last = events.findLast(event => event.timestamp)?.timestamp ?? null;
  const replicas = session.userId.startsWith('workload_replicas_') || events.some(event => event.actor?.provider === 'replicas');
  const source = replicas ? 'Replicas' : session.origin === 'desktop' ? 'Desktop' : session.origin === 'cli' ? 'CLI' : session.origin === 'cloud' ? 'Cloud' : session.origin;
  const captureOwner = session.userId.startsWith('workload_replicas_') ? 'Workspace capture' : authorName(session.userId, session.mine, data.authors);
  const blocks = transcriptBlocks(events), total = more?.total ?? data.total;
  return <div className="oc-session-viewer">
    <header className="oc-session-header"><div className="oc-session-title">{back}<div><PageHeader title={session.title}/><div className="oc-session-subtitle"><span>{harnessName(session.harness)}</span>{source && <span>{source}</span>}{first && <span className="oc-session-date">{dateLabel(first)}</span>}</div></div></div>
      <Button ref={info} className="oc-icon-button" title="Session details" aria-label="Session details" aria-expanded={details} aria-controls="session-details" onClick={() => details ? closeDetails() : setDetails(true)}><Icon name="info"/></Button></header>
    <div className="oc-session-workspace">
      <div className="oc-session-reading-pane"><div ref={reader} className="oc-session-reading" tabIndex={0} aria-label="Session transcript">
        <div ref={transcript} className="oc-session-transcript">{error && <Notice tone="danger">{error}</Notice>}{first && <p className="oc-session-day">{dateLabel(first, true)}</p>}
          {blocks.length ? <ol className="oc-log" aria-label="Transcript">{blocks.map(block => <TranscriptBlock key={block.key} block={block} agent={harnessName(session.harness)} user={replicas ? 'Unknown sender' : authorName(session.userId, session.mine, data.authors)}/>)}</ol>
            : <EmptyState title="No readable messages yet" description="This page contains only capture metadata. Load more of the session to continue."/>}
          <p className="oc-session-count" role="status">Showing {events.length.toLocaleString()} of {total.toLocaleString()} captured events.</p>
          {moreState.error && <Notice tone="danger">{moreState.error}</Notice>}
          <div ref={end} className="oc-session-end" aria-hidden="true"/>
        </div></div>
        {(awayFromBottom || next) && <ScrollControl className="oc-session-jump" busy={moreState.busy} onClick={() => {
          if (!awayFromBottom) {void loadMore();}
          else if (next) {jumpPending.current = true; void loadMore(true);}
          else end.current?.scrollIntoView({behavior: 'instant', block: 'end'});
        }}>{awayFromBottom ? 'Jump to latest' : 'Load more'}</ScrollControl>}
      </div>
      {details && <aside id="session-details" className="oc-session-details" aria-labelledby="session-details-title" onKeyDown={event => {if (event.key === 'Escape') closeDetails();}}>
        <div className="oc-session-details-title"><h2 id="session-details-title" ref={panelHeading} tabIndex={-1}>Session details</h2><Button variant="quiet" className="oc-icon-button" aria-label="Close details" onClick={closeDetails}><Icon name="close" size={16}/></Button></div>
        <MetaList items={[{label: 'Captured by', value: captureOwner}, {label: 'Agent', value: harnessName(session.harness)}, {label: 'Source', value: source}, {label: 'Origin', value: session.origin},
          {label: 'First event', value: fullTime(first)}, {label: next ? 'Last loaded event' : 'Last event', value: fullTime(last)}, {label: 'Captured events', value: total.toLocaleString()},
          {label: 'Captured on', value: <CaptureHostname session={session} expanded/>}, {label: 'Visibility', value: current === 'private' ? <VisibilityBadge value/> : 'Shared with workspace'}, {label: 'Session ID', value: <code>{session.sessionId}</code>}]}/>
        {current === 'private' && <Notice>Only you can see this session. Teammates and their agents cannot read or search it.</Notice>}
        {session.mine && <OwnerControls noun="session" visibility={current}
          onVisibility={async (value, signal) => {await mutate('sessions/visibility', {harness: session.harness, sessionId: session.sessionId, visibility: value}, signal); setVisibility(value);}}
          onDelete={async signal => {await mutate('sessions/delete', {harness: session.harness, sessionId: session.sessionId}, signal); navigate('/sessions', {replace: true});}}
          deleteDescription="Permanently remove this transcript, uploaded attachments, and search results for everyone. This session cannot be captured again, including from another installation. Local files on your computer are unchanged."/>}
      </aside>}
    </div>
  </div>;
}
