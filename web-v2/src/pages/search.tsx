import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Button, EmptyState, Field, Input, LoadingState, Notice, Section} from '../design/components.js';
import {Icon} from '../design/icons.js';
import type {ConsoleDataAdapter, DiagnosticHit, DiagnosticSearch} from './types.js';
import {excerpt, highlightedText, searchGroups, searchHit} from './search-model.js';
import type {SearchSource} from './search-model.js';
import {SearchReader} from './search-reader.js';

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
function SearchHit({hit, query, source}: {hit: DiagnosticHit; query: string; source: SearchSource}) {
  const item = searchHit(hit, source), preview = excerpt(item.body, query);
  return (
    <article className="oc-search-hit">
      <h3>{item.title}</h3>
      {(item.context.length > 0 || item.timestamp) && (
        <dl className="oc-search-context">
          {item.context.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
          {item.timestamp && (
            <div><dt>{item.timestampLabel}</dt><dd><time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})}</time></dd></div>
          )}
        </dl>
      )}
      <p className="oc-search-excerpt">
        {item.body ? <>{preview.leading && '…'}<Highlight text={preview.text} query={query}/>{preview.trailing && '…'}</> : 'No indexed text was returned for this item.'}
      </p>
      {item.serverExcerpt && <p className="oc-search-coverage">This result contains a returned excerpt of the indexed document.</p>}
      {(preview.leading || preview.trailing) && <TextDisclosure body={item.body} serverExcerpt={item.serverExcerpt}/>}
      {item.url && <a className="oc-search-source-link" href={item.url} target="_blank" rel="noopener noreferrer">Open source<Icon name="external" size={16}/></a>}
      <JsonDisclosure label="Item metadata and JSON" value={hit}/>
    </article>
  );
}
export function SearchResults({result, query}: {result: DiagnosticSearch; query: string}) {
  const groups = searchGroups(result);
  const returned = groups.reduce((sum, group) => sum + group.hits.length, 0);
  const partial = result.partial || result.truncated || groups.some(group => group.warnings.length > 0);
  return (
    <div className="oc-search-results">
      <p className="oc-search-summary" role="status">{returned.toLocaleString()} {returned === 1 ? 'result' : 'results'} returned for “{query}”.</p>
      {result.partial && !groups.some(group => group.state !== 'ready') && <Notice tone="warning">Some sources did not complete. Returned results may be incomplete.</Notice>}
      {result.truncated && !groups.some(group => group.truncated) && <Notice tone="warning">Only part of the matching results was returned. Narrow the query for a more focused inspection.</Notice>}
      {!groups.length && <Notice tone="warning">The response did not include search coverage. Try the query again.</Notice>}
      {groups.length > 0 && !returned && !partial && <EmptyState title="No matching items" description="Try another query, or check the connected sources and captured sessions."/>}
      {groups.filter(group => group.hits.length || group.warnings.length).map(group => (
        <Section key={group.id} className="oc-search-group" title={`${group.label} (${group.hits.length})`}>
          {group.total !== undefined && (group.total > group.hits.length || group.totalRelation === 'gte') && (
            <p className="oc-search-coverage">Showing {group.hits.length.toLocaleString()} of {group.totalRelation === 'gte' ? 'at least ' : ''}{group.total.toLocaleString()} reported matches.</p>
          )}
          {group.warnings.length > 0 && <Notice tone="warning">{group.warnings.join(' ')}</Notice>}
          <div>{group.hits.map((hit, index) => <SearchHit key={`${hit._id || 'item'}:${index}`} hit={hit} query={query} source={group.id}/>)}</div>
        </Section>
      ))}
      <JsonDisclosure label="Raw search response" value={result}/>
    </div>
  );
}
export function SearchInspector({adapter}: {adapter: Pick<ConsoleDataAdapter, 'search'>}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const reader = useMemo(() => new SearchReader(adapter), [adapter]);
  const snapshot = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  const busy = snapshot.state === 'loading';
  useEffect(() => () => reader.cancel(), [reader]);
  return (
    <Section className="oc-search-inspector" aria-label="Inspect search">
      <p className="oc-search-intro">Run a diagnostic query to inspect the indexed text and source metadata available to your agents.</p>
      <form className="query-form" onSubmit={event => {event.preventDefault(); void reader.search(query);}}>
        <Field label="Search query">
          <Input ref={input} type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={4000} required placeholder="Enter a diagnostic query"/>
        </Field>
        <div className="actions">
          <Button type="submit" variant="primary" disabled={!query.trim()} aria-busy={busy || undefined}>Run query</Button>
          {busy && <Button onClick={() => {reader.cancel(); input.current?.focus();}}>Cancel</Button>}
        </div>
      </form>
      {snapshot.state === 'failed' && <Notice tone="danger">{snapshot.error}</Notice>}
      {snapshot.state === 'canceled' && <p role="status" className="muted">Query canceled.</p>}
      {busy && <LoadingState label="Running query"/>}
      {snapshot.result && <SearchResults key={snapshot.query} result={snapshot.result} query={snapshot.query}/>}
    </Section>
  );
}
