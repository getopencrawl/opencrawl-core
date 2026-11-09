import {useState} from 'react';
import {Button, EmptyState, Field, Input, LoadingState, Notice, PageHeader, Tabs} from '../design/components.js';
import {Icon} from '../design/icons.js';
import {Link, useNavigate, useSearchParams} from '../router.js';
import type {Harness, LibraryAdapter, LibraryScope, MemoryRef, Visibility} from './library-types.js';
import {MetaList, OwnerControls, VisibilityBadge, When, authorName, harnessName} from './library-controls.js';
import {sessionPath} from './sessions.js';
import {useResource} from './use-resource.js';

const harnessOf = (value: string | null): Harness | null => value === 'claude-code' || value === 'codex' ? value : null;
export function memoryPath({userId, harness, path}: MemoryRef) {
  return '/memories?' + new URLSearchParams({user: userId, harness, path}).toString();
}

/** Current memory files agents have written, as captured by OpenCrawl. */
export function MemoriesPage({adapter}: {adapter: LibraryAdapter}) {
  const [params] = useSearchParams();
  const userId = params.get('user'), harness = harnessOf(params.get('harness')), path = params.get('path');
  if (userId && harness && path) return <MemoryViewer key={memoryPath({userId, harness, path})} adapter={adapter} reference={{userId, harness, path}}/>;
  return <MemoryList adapter={adapter}/>;
}

function MemoryList({adapter}: {adapter: LibraryAdapter}) {
  const [params, setParams] = useSearchParams();
  const scope: LibraryScope = params.get('scope') === 'mine' ? 'mine' : 'all';
  const [filter, setFilter] = useState('');
  const {data, error, loading, retry} = useResource(scope, 0, signal => adapter('memories/list', {scope}, signal), 'Memories could not load. Try again.');
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = data?.memories.filter(memory => words.every(word => [memory.path, memory.description, memory.project].some(value => value.toLowerCase().includes(word)))) ?? [];
  return <div className="oc-library">
    <PageHeader title="Memories" description="Memory files your agents keep, captured so teammates’ agents can use them. Private memories are visible only to the person who captured them."/>
    {params.get('deleted') === '1' && <Notice tone="success">Memory deleted. If the agent rewrites the file later, the new version is captured again.</Notice>}
    <Tabs label="Memories shown" value={scope} onChange={value => setParams(value === 'mine' ? {scope: 'mine'} : {})} items={[{value: 'all', label: 'All memories'}, {value: 'mine', label: 'My memories'}]}/>
    {data && data.memories.length > 0 && <div className="query-form"><Field label="Filter memories"><Input type="search" value={filter} maxLength={200} onChange={event => setFilter(event.target.value)} placeholder="Path, project or description"/></Field></div>}
    {error && <Notice tone="danger">{error}</Notice>}
    {error && <div className="actions"><Button onClick={retry}>Try again</Button></div>}
    {!data && loading && <LoadingState label="Loading memories"/>}
    {data?.truncated && <Notice tone="warning">Showing the 1,000 most recently changed memory files.</Notice>}
    {data && (shown.length ? <ul className="oc-library-list">{shown.map(memory => <li key={memoryPath(memory)} className="oc-library-item">
      <div className="oc-library-heading"><Link to={memoryPath(memory)} className="oc-library-title">{memory.description || memory.path}</Link><VisibilityBadge value={memory.private}/></div>
      <MetaList items={[{label: 'File', value: <code>{memory.path}</code>}, {label: 'Captured by', value: authorName(memory.userId, memory.mine, data.authors)},
        {label: 'Agent', value: harnessName(memory.harness)}, {label: 'Updated', value: <When value={memory.modifiedAt}/>}]}/>
    </li>)}</ul> : <EmptyState title={words.length ? 'No matching memories' : scope === 'mine' ? 'You have no captured memories yet' : 'No captured memories yet'}
      description={words.length ? 'Try a different filter.' : 'Memories appear after an agent with OpenCrawl capture writes to its memory files.'}/>)}
  </div>;
}

function MemoryViewer({adapter, reference}: {adapter: LibraryAdapter; reference: MemoryRef}) {
  const navigate = useNavigate();
  const {data, error, loading, retry} = useResource(memoryPath(reference), 0, signal => adapter('memories/read', reference, signal), 'This memory could not load. Try again.');
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const back = <Link to="/memories" className="oc-library-back"><Icon name="arrow-left"/>All memories</Link>;
  if (!data) return <div className="oc-library">{back}<PageHeader title="Memory"/>{loading ? <LoadingState label="Loading memory"/> : <>
    <Notice tone="danger">{error}</Notice><div className="actions"><Button onClick={retry}>Try again</Button></div></>}</div>;
  const {memory} = data, current: Visibility = visibility ?? (memory.private ? 'private' : 'team');
  return <div className="oc-library oc-library-viewer">
    {back}
    <PageHeader title={memory.path.split('/').at(-1) || memory.path}/>
    <div className="oc-library-heading"><VisibilityBadge value={current === 'private'}/></div>
    <MetaList items={[{label: 'File', value: <code>{memory.path}</code>}, {label: 'Project', value: memory.project}, {label: 'Captured by', value: authorName(memory.userId, memory.mine, data.authors)},
      {label: 'Agent', value: harnessName(memory.harness)}, {label: 'Updated', value: <When value={memory.modifiedAt}/>},
      {label: 'Written in', value: memory.sourceSessionId ? <Link to={sessionPath({userId: memory.userId, harness: memory.harness, sessionId: memory.sourceSessionId})}>Source session</Link> : null}]}/>
    {memory.mine && <OwnerControls noun="memory" visibility={current}
      onVisibility={async (value, signal) => {await adapter('memories/visibility', {harness: memory.harness, path: memory.path, visibility: value}, signal); setVisibility(value);}}
      onDelete={async signal => {await adapter('memories/delete', {harness: memory.harness, path: memory.path}, signal); navigate('/memories?deleted=1', {replace: true});}}
      deleteDescription="OpenCrawl removes this memory from search for everyone and ignores this version in future captures. The file on your machine is not changed; if the agent rewrites it, the new version is captured."/>}
    {current === 'private' && <Notice>Only you can see this memory. Teammates and their agents cannot read or search it.</Notice>}
    <div className="preserve-text bounded-text oc-memory-text" tabIndex={0} role="region" aria-label="Memory contents">{data.text}</div>
  </div>;
}
