import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Button, EmptyState, ExternalLink, Field, Input, LoadingState, Notice} from '../design/components.js';
import {Icon} from '../design/icons.js';
import type {ConsoleDataAdapter, DiagnosticHit, DiagnosticSearch} from './types.js';
import {excerpt, highlightedText, resultSummary, searchGroups, searchHit} from './search-model.js';
import type {SearchSource} from './search-model.js';
import {diagnosticPage, SEARCH_PAGE_SIZE, SOURCE_WINDOW} from '../../../src/application/search-page.mjs';
import {Link} from '../router.js';
import {memoryHarness, memoryPath} from './memories.js';
import {sessionHarness, sessionPath} from './sessions.js';
import {messageHref} from './board.js';
import {SearchReader} from './search-reader.js';
import {accessFailure, consoleResourceKey, useConsoleAccessFailure, useConsoleModel} from '../data.tsx';

export function JsonDisclosure({label, value}: {label: string; value: unknown}) {
  const [open, setOpen] = useState(false);
  const content = useMemo(() => open ? JSON.stringify(value, null, 2) : undefined, [open, value]);
  return (
    <details className="oc-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{label}</summary>
      {open && <pre className="code-block" tabIndex={0} aria-label={label}>{content}</pre>}
    </details>
  );
}
function TextDisclosure({body, serverExcerpt}: {body: string; serverExcerpt: boolean}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="oc-disclosure" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{serverExcerpt ? 'Read returned excerpt' : 'Read full indexed text'}</summary>
      {open && <div className="preserve-text bounded-text" tabIndex={0} role="region" aria-label={serverExcerpt ? 'Returned indexed excerpt' : 'Full indexed text'}>{body}</div>}
    </details>
  );
}
function Highlight({text, query}: {text: string; query: string}) {
  return <>{highlightedText(text, query).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text)}</>;
}
const examples = ['onboarding', 'launch checklist', 'design review', 'customer feedback', 'release notes', 'first prototype'];

function sourcePath(hit: DiagnosticHit, source: SearchSource) {
  const {userId, harness, sessionId, path, channel, messageId, threadId} = hit._source ?? {};
  if (source === 'board' && typeof channel === 'string' && channel && typeof messageId === 'number' && Number.isSafeInteger(messageId) && messageId > 0 &&
      typeof threadId === 'number' && Number.isSafeInteger(threadId) && threadId > 0) return messageHref(channel, messageId, threadId);
  if (typeof userId !== 'string' || !userId || typeof harness !== 'string') return;
  if (source === 'sessions' && typeof sessionId === 'string' && sessionId) {
    const kind = sessionHarness(harness);
    if (kind) return sessionPath({userId, harness: kind, sessionId});
  }
  if (source === 'memories' && typeof path === 'string' && path) {
    const kind = memoryHarness(harness);
    if (kind) return memoryPath({userId, harness: kind, path});
  }
}

function SearchHit({hit, query, source}: {hit: DiagnosticHit; query: string; source: SearchSource}) {
  const item = searchHit(hit, source, query), preview = excerpt(item.body, query, 240);
  const internal = sourcePath(hit, source);
  const sameText = item.userPrompt && item.title === item.body.trim();
  const label = sameText ? <Highlight text={item.title} query={query}/> : item.title;
  const title = internal ? <Link to={internal}>{label}</Link>
    : item.url ? <ExternalLink href={item.url}>{label}</ExternalLink> : label;
  const sourceIcon = {sessions: 'sessions', memories: 'memories', connectors: 'sources', board: 'diagnostics'} as const;
  return (
    <article className={`oc-search-hit${item.userPrompt ? ' oc-search-prompt' : ''}`}>
      <h2>{title}</h2>
      <div className="oc-search-context">
        <Icon name={sourceIcon[source]} size={14}/>
        {item.url && <span>{new URL(item.url).host}</span>}
        {item.context.map(field => <span key={field.label} className={field.label === 'Type' && item.userPrompt ? 'oc-search-prompt-label' : undefined} title={field.value}><span className="sr-only">{field.label} </span>{field.value}</span>)}
        {item.timestamp && <time dateTime={item.timestamp} title={new Date(item.timestamp).toLocaleString()}>{new Date(item.timestamp).toLocaleDateString(undefined, {dateStyle: 'medium'})}</time>}
      </div>
      {!sameText && <p className="oc-search-excerpt">
        {item.serverExcerpt && <span className="oc-search-excerpt-label">Excerpt — </span>}
        {item.body ? <>{preview.leading && '…'}<Highlight text={preview.text} query={query}/>{preview.trailing && '…'}</> : 'No indexed text was returned for this item.'}
      </p>}
      <div className="oc-search-tools">
        {(preview.leading || preview.trailing) && <TextDisclosure body={item.body} serverExcerpt={item.serverExcerpt}/>}
        <JsonDisclosure label="Item metadata and JSON" value={hit}/>
      </div>
    </article>
  );
}
export function SearchResults({result: response, query, onPage, focusSummary = false, showQuery = true}: {
  result: DiagnosticSearch; query: string; onPage?(page: number): void; focusSummary?: boolean; showQuery?: boolean;
}) {
  const [localPage, setLocalPage] = useState(1);
  const result = useMemo(() => response.page ? response : diagnosticPage(response, localPage), [response, localPage]);
  const changePage = response.page ? onPage : setLocalPage;
  const summary = useRef<HTMLParagraphElement>(null);
  useEffect(() => {if (focusSummary || localPage > 1) summary.current?.focus();}, [focusSummary, localPage, result]);
  const page = result.page?.number ?? 1;
  const hasNext = result.page?.hasNext === true;
  const groups = searchGroups(result);
  const returned = groups.reduce((sum, group) => sum + group.hits.length, 0);
  const partial = result.partial || result.truncated || groups.some(group => group.warnings.length > 0);
  return (
    <div className="oc-search-results">
      <p className="oc-search-summary" role="status" ref={summary} tabIndex={-1}>
        {resultSummary(groups, page, SEARCH_PAGE_SIZE, hasNext, partial)}{showQuery && ` for “${query}”`}
      </p>
      {result.partial && !groups.some(group => group.state !== 'ready') && <Notice tone="warning">Some sources did not complete. Returned results may be incomplete.</Notice>}
      {result.truncated && !groups.some(group => group.truncated) && <Notice tone="warning">Only part of the matching results was returned. Narrow the query for a more focused inspection.</Notice>}
      {!groups.length && <Notice tone="warning">The response did not include search coverage. Try the query again.</Notice>}
      {groups.length > 0 && !returned && page === 1 && !partial && <EmptyState title="No matching items" description="Try another query, or check the connected sources and captured sessions."/>}
      {groups.filter(group => group.hits.length || group.warnings.length).map(group => (
        <section key={group.id} className="oc-search-group" aria-label={`${group.label} (${group.hits.length})`}>
          {group.warnings.length > 0 && <Notice tone="warning" title={group.label}>{group.warnings.join(' ')}</Notice>}
          {group.hits.map((hit, index) => <SearchHit key={`${hit._id || 'item'}:${index}`} hit={hit} query={query} source={group.id}/>)}
        </section>
      ))}
      {page > 1 && !returned && <p className="muted">The results changed. Return to the previous page or run the query again.</p>}
      {result.page?.windowLimited && <p className="oc-search-coverage">The playground checks up to {SOURCE_WINDOW} matches per source. Refine your query to explore further.</p>}
      {changePage && (page > 1 || hasNext) && <div role="group" className="oc-search-pagination" aria-label="Search result pages">
        <Button onClick={() => changePage(page - 1)} disabled={page === 1}><Icon name="chevron-left" size={16}/>Previous</Button>
        <span aria-current="page">Page {page}</span>
        <Button onClick={() => changePage(page + 1)} disabled={!hasNext}>Next<Icon name="chevron-right" size={16}/></Button>
      </div>}
      <JsonDisclosure label="Raw search response" value={response}/>
    </div>
  );
}
export function SearchInspector({adapter}: {adapter: Pick<ConsoleDataAdapter, 'search'>}) {
  const deny=useConsoleAccessFailure();
  const model=useConsoleModel(consoleResourceKey(adapter,'search'),()=>({draft:'',reader:new SearchReader({search:async(query,signal,page)=>{try{return await adapter.search(query,signal,page);}catch(error){if(accessFailure(error))deny?.(error);throw error;}}})}));
  const [draft,setDraft]=useState({model,value:model.draft});
  const query=draft.model===model?draft.value:model.draft;
  const setQuery=(value:string)=>{model.draft=value;setDraft({model,value});};
  const input = useRef<HTMLInputElement>(null);
  const reader = model.reader;
  const snapshot = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  const paging = useRef(false);
  function run(value: string) {paging.current = false; void reader.search(value);}
  function surprise() {
    const choices = examples.filter(example => example !== query && example !== snapshot.query);
    const example = choices[Math.floor(Math.random() * choices.length)]!;
    setQuery(example); run(example);
  }
  const busy = snapshot.state === 'loading';
  useEffect(() => () => reader.suspend(), [reader]);
  return (
    <section className="oc-search-inspector" aria-label="Inspect search">
      <form className="query-form" onSubmit={event => {event.preventDefault(); run(query);}}>
        <Field label="Search query">
          <Input ref={input} type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={4000} required placeholder="Search your workspace"/>
        </Field>
        <div className="actions">
          <Button type="submit" variant="primary" disabled={!query.trim()} aria-busy={busy || undefined}><Icon name="search" size={16}/>Run query</Button>
          {!busy && <Button onClick={surprise}><Icon name="dice" size={18}/>Surprise me</Button>}
          {busy && <Button onClick={() => {reader.cancel(); input.current?.focus();}}>Cancel</Button>}
        </div>
      </form>
      {snapshot.state === 'failed' && <Notice tone="danger">{snapshot.error}</Notice>}
      {snapshot.state === 'canceled' && <p role="status" className="muted">Query canceled.</p>}
      {busy && <LoadingState label="Running query"/>}
      {snapshot.result && <SearchResults key={snapshot.query} result={snapshot.result} query={snapshot.query} showQuery={query.trim() !== snapshot.query} focusSummary={paging.current} onPage={page => {paging.current = true; void reader.search(snapshot.query, page);}}/>}
    </section>
  );
}
