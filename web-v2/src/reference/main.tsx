import {useEffect, useState} from 'react';
import type {FormEvent} from 'react';
import {createRoot} from 'react-dom/client';
import {AppRouter, Link} from '../router.tsx';
import {AppShell} from '../app.tsx';
import {Button, CopyField, EmptyState, Field, Input, LoadingState, Notice, Page, Section, Table} from '../design/components.tsx';
import {JsonDisclosure, SearchInspector} from '../pages/diagnostics.tsx';
import type {DiagnosticSearch, LibraryAdapter, NavigationItem} from '../index.ts';
import {SessionsPage} from '../pages/sessions.tsx';
import {MemoriesPage} from '../pages/memories.tsx';
import {workspaceSearchDiagnostics} from './search.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};}
function rows(value: unknown): ObjectValue[] {return Array.isArray(value) ? value.map(object) : [];}
function text(value: unknown) {return typeof value === 'string' ? value : '';}
async function request(path: string, signal: AbortSignal, body?: object): Promise<ObjectValue> {
  const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: body ? {'content-type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined, signal});
  const result: unknown = await response.json();
  if (!response.ok) throw Object.assign(new Error(text(object(object(result).error).message) || 'The local service could not complete this request. Check its configuration and try again.'), {status: response.status});
  return object(result);
}
// The server validates every response field it relies on; the console only renders.
const library: LibraryAdapter = async (operation, input, signal) => await request('/api/reference/library/' + operation, signal, input) as never;
const adapter = {async search(query: string, signal: AbortSignal): Promise<DiagnosticSearch> {
  const response = await request('/api/reference/search', signal, {query});
  return workspaceSearchDiagnostics(response.data);
}};
function PassageReader() {
  const [id, setId] = useState(''), [result, setResult] = useState<ObjectValue | null>(null), [error, setError] = useState(''), [busy,setBusy] = useState(false);
  const [controller] = useState(() => ({current: new AbortController()}));
  useEffect(() => () => controller.current.abort(), [controller]);
  async function submit(event: FormEvent) {event.preventDefault(); controller.current.abort(); controller.current = new AbortController(); const signal=controller.current.signal; setBusy(true);setError('');setResult(null);try {const response=await request('/api/reference/fetch',signal,{id:id.trim()}); if(!signal.aborted)setResult(object(response.data));} catch(failure) {if(!signal.aborted)setError(failure instanceof Error ? failure.message : 'The passage could not load.');} finally {if(!signal.aborted)setBusy(false);}}
  return <Section title="Read a passage" description="Copy a passageId from a search result to read its indexed source and provenance."><form className="query-form" onSubmit={event=>void submit(event)}><Field label="Passage ID"><Input value={id} onChange={event=>setId(event.target.value)} required maxLength={1000}/></Field><Button type="submit" busy={busy}>Read passage</Button></form>{error && <Notice tone="danger">{error}</Notice>}{result && <><p className="preserve-text bounded-text">{text(result.text)}</p><JsonDisclosure label="Passage provenance and JSON" value={result}/>{result.nextOffset != null && <Notice>This passage continues beyond this preview. Use the fetch tool with the returned nextOffset and version to read the next section.</Notice>}</>}</Section>;
}
function Diagnostics() {return <Page title="Diagnostics" description="Inspect the knowledge available to agents in this deployment."><SearchInspector adapter={adapter}/><PassageReader/></Page>;}
function Agents() {
  const [data,setData]=useState<ObjectValue[] | null>(null), [error,setError]=useState(''), [revision,setRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();setData(null);setError('');request('/api/reference/agents',controller.signal).then(result=>{if(!controller.signal.aborted)setData(rows(object(result.data).agents));}).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error ? failure.message : 'Agents could not load.');});return()=>controller.abort();},[revision]);
  return <Page title="Agents" description="Sessions registered with this deployment’s coordination board." actions={<Button onClick={()=>setRevision(value=>value+1)}>Refresh</Button>}>{error && <Notice tone="warning">{error}</Notice>}{!error && !data && <LoadingState label="Loading agents"/>}{data && (data.length ? <Table label="Registered agents"><thead><tr><th scope="col">Agent</th><th scope="col">Task</th><th scope="col">Listening</th></tr></thead><tbody>{data.map((agent,index)=><tr key={text(agent.agent)||index}><th scope="row">{text(agent.name)}</th><td>{text(agent.task)}</td><td>{agent.listening ? 'Yes' : 'No'}</td></tr>)}</tbody></Table> : <EmptyState title="No registered agents" description="Agents appear here when they register with the workspace board."/>)}</Page>;
}
function ReferenceApp() {
  const [configuration,setConfiguration]=useState<ObjectValue | null>(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();request('/api/reference/config',controller.signal).then(setConfiguration).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error ? failure.message : 'Configuration could not load.');});return()=>controller.abort();},[]);
  if(error)return <Notice tone="danger">{error}</Notice>;
  if(!configuration)return <LoadingState label="Opening workspace"/>;
  const name=text(configuration.name)||'Local workspace', endpoint=text(configuration.mcpEndpoint);
  const routes: NavigationItem[]=[
    {path:'/',label:'Overview',icon:'overview',element:<Page title="Overview" description="Manage your self-hosted OpenCrawl workspace."><Section title="Agent connection" description="The deployment’s configured connection is shared by your agents and this console."><CopyField label="MCP endpoint" value={endpoint}/><p className="muted">The endpoint is configured. Run a diagnostic query to verify retrieval against your current index.</p></Section><Section title="Workspace controls"><div className="data-list"><div className="data-row"><div><h3>Inspect retrieval</h3><p>Read indexed text, passages and source provenance.</p></div><Link to="/diagnostics">Open diagnostics</Link></div><div className="data-row"><div><h3>Agent coordination</h3><p>See registered sessions and their current tasks.</p></div><Link to="/agents">View agents</Link></div></div></Section></Page>},
    {path:'/sessions',label:'Sessions',icon:'sessions',element:<SessionsPage adapter={library}/>},
    {path:'/memories',label:'Memories',icon:'memories',element:<MemoriesPage adapter={library}/>},
    {path:'/diagnostics',label:'Diagnostics',icon:'diagnostics',element:<Diagnostics/>},
    {path:'/agents',label:'Agents',icon:'team',element:<Agents/>},
    {path:'/settings',label:'Settings',icon:'settings',group:'manage',element:<Page title="Settings" description="Connection and access settings for this deployment."><Section title="Connection"><CopyField label="MCP endpoint" value={endpoint}/><p className="muted">Change the server’s OPENCRAWL_MCP_URL setting to use a different deployment. Restart this console after updating server configuration.</p></Section><Section title="Access"><p>The console requires its own password. The upstream agent token stays on the server. Your deployment’s fixed identity and resource permissions apply to every request.</p></Section></Page>},
  ];
  return <AppShell workspace={{name,userName:'Operator'}} routes={routes}/>;
}
const target=document.getElementById('app');
if(!target)throw new Error('Application mount is missing.');
createRoot(target).render(<AppRouter><ReferenceApp/></AppRouter>);
