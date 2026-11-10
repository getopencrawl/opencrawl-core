import {Component, useCallback, useEffect, useRef, useState, useMemo} from 'react';
import type {ErrorInfo, ReactNode} from 'react';
import {ConsoleDataProvider, useConsolePrefetch, useConsoleQueryClient, consoleResourceKey, libraryResourceKey, AppRouter, AppShell, FocusedFrame, AgentOnboarding, SourcesOnboarding, InviteOnboarding, UsagePage, SessionsPage, MemoriesPage, DiagnosticsPage, Button, LoadingState, Notice, Page, LinkButton, Navigate, Routes, Route, useLocation, useNavigate} from '../index.ts';
import type {ConsoleDataAdapter, NavigationItem, OnboardingAdapter} from '../index.ts';
import type {Bootstrap, ProductApi} from './api.ts';
import {SourcesPage} from './sources.tsx';
import {TeamPage, TeamLoadingPage} from './team.tsx';
import {DocumentFrame, ProductDocument, readBrowserDocument} from './documents.tsx';

export interface ConsoleRoute extends NavigationItem {pending?: (feedback?: ReactNode) => ReactNode}
export function PendingPage({title, description, className, bodyClassName, children}: {title: string; description?: string; className?: string; bodyClassName?: string; children?: ReactNode}) {
  return <Page title={title} description={description} className={className} bodyClassName={bodyClassName}>{children ?? <LoadingState label={`Loading ${title.toLowerCase()}`} />}</Page>;
}
export interface ConsoleExtensionContext<B extends Bootstrap> {data: B | null; activated: (signal: AbortSignal) => Promise<void>}
export interface ConsoleExtensions<B extends Bootstrap> {
  document?: (page: unknown) => ReactNode | undefined;
  routes?: (context: ConsoleExtensionContext<B>) => ConsoleRoute[];
  decorateRoute?: (route: ConsoleRoute, data: B) => ConsoleRoute;
  teamFooter?: ReactNode;
  prefetches?: ReadonlyArray<{key: readonly unknown[]; read: (signal: AbortSignal) => Promise<unknown>; staleMilliseconds?: number}>;
}
function WarmWorkspace({prefetches}: {prefetches: NonNullable<ConsoleExtensions<Bootstrap>['prefetches']>}) {
  useConsolePrefetch(prefetches);
  const cache=useConsoleQueryClient();
  useEffect(()=>{
    const changed=()=>{void cache?.invalidateQueries();};
    window.addEventListener('opencrawl:console-mutated',changed);
    return ()=>window.removeEventListener('opencrawl:console-mutated',changed);
  },[cache]);
  return null;
}
function SignOut() {return <form method="post" action="/auth/logout"><Button type="submit" variant="quiet">Sign out</Button></form>;}
class ErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Do not emit private workspace content to third parties. */ }
  render() {return this.state.failed ? <FocusedFrame footer={<SignOut/>}><Notice tone="danger" title="This page couldn’t load">Reload your workspace to try again.</Notice><LinkButton to="/" reloadDocument>Reload workspace</LinkButton></FocusedFrame> : this.props.children;}
}
function ConsoleApp<B extends Bootstrap>({api, extensions}: {api: ProductApi<B>; extensions?: ConsoleExtensions<B>}) {
  const dataAdapter = useMemo<ConsoleDataAdapter>(() => ({usage: api.usage, search: api.search, board: api.board}), [api]);
  const libraryAdapter = api.library;
  const onboardingAdapter = useMemo<OnboardingAdapter>(() => ({
    status: async signal => (await api.onboardingStatus(signal)).data,
    sources: api.onboardingSources, connectSource: (id, input, signal) => api.connect(id, input.apiKey, signal),
    invitations: api.onboardingInvitations, invite: api.onboardingInvite, finish: api.finishOnboarding,
  }), [api]);
  const prefetches = useMemo(() => [
    {key: consoleResourceKey(dataAdapter, 'usage'), read: (signal: AbortSignal) => dataAdapter.usage(signal), staleMilliseconds: 60_000},
    {key: consoleResourceKey(api.sources), read: api.sources},
    {key: consoleResourceKey(api.team), read: api.team},
    {key: libraryResourceKey(libraryAdapter, 'sessions/list', 'all\n', 50), read: (signal: AbortSignal) => libraryAdapter('sessions/list', {scope: 'all', query: '', limit: 50}, signal)},
    {key: libraryResourceKey(libraryAdapter, 'memories/list', 'all'), read: (signal: AbortSignal) => libraryAdapter('memories/list', {scope: 'all'}, signal)},
    ...(extensions?.prefetches ?? []),
  ], [api, dataAdapter, libraryAdapter, extensions]);
  const [data,setData] = useState<B | null>(null), [error,setError] = useState('');
  const [attempt,setAttempt] = useState(0);
  const accessEpoch=useRef(0),blocked=useRef(false);
  const invalidateAccess=useCallback((failure:unknown)=>{accessEpoch.current++;blocked.current=true;setData(null);setError(failure instanceof Error?failure.message:typeof failure==='string'?failure:'Your workspace access changed. Sign in again.');},[]);
  const navigate = useNavigate(), location = useLocation();
  const refresh = useCallback(async () => {const epoch=accessEpoch.current;const next = await api.bootstrap();if(epoch!==accessEpoch.current||blocked.current)throw new Error('Your workspace access changed. Sign in again.');setData(next);return next;},[api]);
  useEffect(() => {
    const controller=new AbortController();let active=false,loaded=false;blocked.current=false;const epoch=++accessEpoch.current;
    const load=async()=>{
      if(active||blocked.current||document.visibilityState==='hidden')return;active=true;
      try {const next=await api.bootstrap(controller.signal);if(!controller.signal.aborted&&epoch===accessEpoch.current&&!blocked.current){loaded=true;setData(next);setError('');}}
      catch(failure){if(!controller.signal.aborted && (!loaded || failure instanceof Error && 'status' in failure && [401,402,403].includes(Number(failure.status)))){setData(null);setError(failure instanceof Error?failure.message:'Your workspace could not load.');}}
      finally{active=false;}
    };
    const focus=()=>{if(document.visibilityState==='visible')void load();};
    const denied=(event:Event)=>invalidateAccess(event instanceof CustomEvent?event.detail:undefined);
    void load();const timer=window.setInterval(focus,60_000);
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);window.addEventListener('opencrawl:access-denied',denied);
    return()=>{controller.abort();clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);window.removeEventListener('opencrawl:access-denied',denied);};
  },[attempt,invalidateAccess,api]);
  const activated = async (signal: AbortSignal) => {
    const epoch = accessEpoch.current;
    const next = await api.bootstrap(signal);
    if (signal.aborted || epoch !== accessEpoch.current || blocked.current) return;
    // Commit admission and navigation together before the initiating page unmounts.
    setData(next); navigate(next.onboarding.completed ? '/' : next.onboarding.next);
  };
  const onboarding = location.pathname.startsWith('/onboarding');
  const routes: ConsoleRoute[] = [
    {path:'/',label:'Usage',icon:'usage',element:<UsagePage adapter={dataAdapter}/>,pending:feedback => <PendingPage bodyClassName="usage-report" title="Usage" description="Workspace usage">{feedback}</PendingPage>},
    {path:'/sessions',label:'Sessions',icon:'sessions',element:<SessionsPage adapter={libraryAdapter}/>,pending:feedback => <PendingPage bodyClassName="oc-library" title="Sessions" description="Agent sessions captured across your workspace. Private sessions are visible only to the person who captured them.">{feedback}</PendingPage>},
    {path:'/memories',label:'Memories',icon:'memories',element:<MemoriesPage adapter={libraryAdapter}/>,pending:feedback => <PendingPage bodyClassName="oc-library" title="Memories" description="Memory files your agents keep, captured so teammates’ agents can use them. Private memories are visible only to the person who captured them.">{feedback}</PendingPage>},
    {path:'/sources',label:'Integrations',icon:'sources',element:<SourcesPage adapter={api}/>,pending:feedback => <PendingPage bodyClassName="oc-connections" title="Integrations" description="Connect your tools and OpenCrawl keeps their content in sync for your agents.">{feedback}</PendingPage>},
    {path:'/usage',label:'Usage',navigation:false,element:<Navigate to={'/' + location.search} replace/>},
    {path:'/diagnostics',label:'Diagnostics',icon:'diagnostics',element:<DiagnosticsPage adapter={dataAdapter} canInspect={data?.workspace.role === 'admin'}/>,pending:feedback => <PendingPage title="Diagnostics" description="See what your agents can retrieve and how they coordinate work.">{feedback}</PendingPage>},
    {path:'/settings',label:'Agent setup',navigation:false,element:<Navigate to="/onboarding" replace/>},
    {path:'/team',label:'Team',icon:'team',group:'manage',element:<TeamPage adapter={api} footer={extensions?.teamFooter} onWorkspaceRenamed={name => setData(current => current ? {...current, workspace: {...current.workspace, name}} : current)}/>,pending:feedback => <TeamLoadingPage>{feedback}</TeamLoadingPage>},
    ...(extensions?.routes?.({data, activated}) ?? []),
    {path:'/integrations',label:'Integrations',navigation:false,element:<Navigate to="/sources" replace/>},
    {path:'/data',label:'Data controls',navigation:false,element:<Navigate to="/sources#data-controls" replace/>},
    {path:'/search',label:'Search inspector',navigation:false,element:<Navigate to="/diagnostics?view=search" replace/>},
    {path:'/_/debug',label:'Diagnostics',navigation:false,element:<Navigate to={'/diagnostics' + location.search} replace/>},
  ];
  if (!data) {
    const feedback = error ? <div className="stack"><Notice tone="danger">{error}</Notice><div className="action-row"><Button onClick={() => setAttempt(value => value + 1)}>Try again</Button><LinkButton to="/auth/login" reloadDocument>Sign in</LinkButton></div></div> : undefined;
    if (onboarding || location.pathname === '/settings') return <FocusedFrame footer={<SignOut/>}>{feedback ?? <LoadingState label="Loading your workspace"/>}</FocusedFrame>;
    const route = routes.find(item => item.path === location.pathname);
    return <AppShell workspace={{name:'Workspace'}} routes={routes} footer={<SignOut/>}>{route?.pending?.(feedback) ?? <PendingPage title={route?.label ?? 'Workspace'}>{feedback}</PendingPage>}</AppShell>;
  }
  if (!data.onboarding.completed && !onboarding) return <Navigate to={data.onboarding.next} replace/>;
  if (onboarding) return <ConsoleDataProvider scopeKey={data.cacheScope} onAccessFailure={invalidateAccess}><FocusedFrame footer={<SignOut/>}><Routes>
    <Route path="/onboarding" element={<AgentOnboarding adapter={onboardingAdapter} mcpUrl={data.mcpUrl} setupPrompt={data.setupPrompt}/>}/>
    <Route path="/onboarding/sources" element={<SourcesOnboarding adapter={onboardingAdapter}/>}/>
    <Route path="/onboarding/invite" element={<InviteOnboarding adapter={onboardingAdapter} canInvite={data.canInvite} onComplete={async path => {await refresh();navigate(path);}}/>}/>
  </Routes></FocusedFrame></ConsoleDataProvider>;
  const shown = extensions?.decorateRoute ? routes.map(route => extensions.decorateRoute!(route, data)) : routes;
  return <ConsoleDataProvider scopeKey={data.cacheScope} onAccessFailure={invalidateAccess}><WarmWorkspace prefetches={prefetches}/><AppShell workspace={data.workspace} routes={shown} footer={<SignOut/>}/></ConsoleDataProvider>;
}
/** One application composition for self-hosted and hosted deployments. */
export function OpenCrawlApp<B extends Bootstrap>({api, extensions}: {api: ProductApi<B>; extensions?: ConsoleExtensions<B>}) {
  return <AppRouter><ErrorBoundary><ApplicationContent api={api} extensions={extensions}/></ErrorBoundary></AppRouter>;
}
function ApplicationContent<B extends Bootstrap>({api,extensions}: {api:ProductApi<B>;extensions?:ConsoleExtensions<B>}) {
  const [page] = useState(readBrowserDocument);
  return page ? <DocumentFrame signedIn={page.signedIn}>{extensions?.document?.(page.page) ?? <ProductDocument page={page.page}/>}</DocumentFrame> : <ConsoleApp api={api} extensions={extensions}/>;
}
