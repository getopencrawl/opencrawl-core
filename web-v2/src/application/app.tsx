import {Component, useEffect, useRef, useState, useMemo} from 'react';
import type {ErrorInfo, ReactNode} from 'react';
import {ConsoleDataProvider, consoleResourceKey, useConsoleQueryClient, AppRouter, AppShell, FocusedFrame, AgentOnboarding, SourcesOnboarding, InviteOnboarding, UsagePage, SessionsPage, MemoriesPage, DiagnosticsPage, Button, LoadingState, Notice, Page, LinkButton, Icon, Navigate, Routes, Route, useLocation, useNavigate} from '../index.ts';
import type {ConsoleDataAdapter, NavigationItem, OnboardingAdapter} from '../index.ts';
import type {Bootstrap, ProductApi} from './api.ts';
import {SourcesPage} from './sources.tsx';
import {RecordingSettings} from '../pages/recording-control.js';
import {replicasAgentSetupPath} from '../onboarding/replicas-agent-setup.tsx';
import {SetupPage} from './setup.tsx';
import {PrivacySettings} from '../pages/privacy-settings.tsx';
import {TeamPage, TeamLoadingPage} from './team.tsx';
import {SearchPlaygroundPage} from '../pages/diagnostics.tsx';
import {DocumentFrame, ProductDocument, readBrowserDocument} from './documents.tsx';

import {useAdmission} from './admission.ts';
import type {ConsoleReload} from '../../../src/application/console-reload.mjs';
import {usagePaths} from '../../../src/application/usage-paths.mjs';
import {matchesConsoleRoute} from '../router.tsx';

function readReload<B extends Bootstrap>(): ConsoleReload<B> | undefined {
  const element = document.getElementById('opencrawl-reload');
  return element ? JSON.parse(element.textContent || 'null') ?? undefined : undefined;
}
export interface ConsoleRoute extends NavigationItem {pending?: (feedback?: ReactNode) => ReactNode}
export function PendingPage({title, description, className, bodyClassName, children}: {title: string; description?: string; className?: string; bodyClassName?: string; children?: ReactNode}) {
  return <Page title={title} description={description} className={className} bodyClassName={bodyClassName}>{children ?? <LoadingState label={`Loading ${title.toLowerCase()}`} />}</Page>;
}
export interface ConsoleExtensionContext<B extends Bootstrap> {data: B | null; activated: (signal: AbortSignal) => Promise<void>}
export interface ConsoleExtensions<B extends Bootstrap> {
  document?: (page: unknown) => ReactNode | undefined;
  routes?: (context: ConsoleExtensionContext<B>) => ConsoleRoute[];
  decorateRoute?: (route: ConsoleRoute, data: B) => ConsoleRoute;
  workspaceNotice?: (data: B) => ReactNode;
  teamFooter?: ReactNode;
  computerApiKeys?: ReactNode;
  reloadKeys?: Record<string, readonly unknown[]>;
}
function WorkspaceInvalidation() {
  const cache=useConsoleQueryClient();
  useEffect(()=>{
    const changed=()=>{void cache?.invalidateQueries();};
    window.addEventListener('opencrawl:console-mutated',changed);
    return ()=>window.removeEventListener('opencrawl:console-mutated',changed);
  },[cache]);
  return null;
}
function SignOut() {return <form method="post" action="/auth/logout"><Button type="submit" variant="quiet"><Icon name="sign-out" size={18}/>Sign out</Button></form>;}
class ErrorBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Do not emit private workspace content to third parties. */ }
  render() {return this.state.failed ? <FocusedFrame footer={<SignOut/>}><Notice tone="danger" title="This page couldn’t load">Reload your workspace to try again.</Notice><LinkButton to="/" reloadDocument>Reload workspace</LinkButton></FocusedFrame> : this.props.children;}
}
function ConsoleApp<B extends Bootstrap>({api, extensions}: {api: ProductApi<B>; extensions?: ConsoleExtensions<B>}) {
  const dataAdapter: ConsoleDataAdapter = api;

  const libraryAdapter = api.library;
  const onboardingAdapter = useMemo<OnboardingAdapter>(() => ({
    status: async signal => (await api.onboardingStatus(signal)).data,
    sources: api.onboardingSources, connectSource: (id, input, signal) => api.connect(id, input.apiKey, signal),
    ...(api.saveCredential ? {saveCredential: (id: string, value: string, signal: AbortSignal) => api.saveCredential!(id, value, signal)} : {}),
    invitations: api.onboardingInvitations, invite: api.onboardingInvite, finish: api.finishOnboarding,
  }), [api]);
  const navigate = useNavigate(), location = useLocation();
  const [initialIntegrationsNav, setInitialIntegrationsNav] = useState(() => document.getElementById('root')?.hasAttribute('data-integrations-nav') === true);
  const [snapshot, setSnapshot] = useState(readReload<B>);
  const {data, error, accessDenied, refresh, retry, rename, invalidateAccess: deny} = useAdmission(api, snapshot?.bootstrap, location.pathname === '/setup');
  const invalidateAccess = (failure: unknown) => {setSnapshot(undefined); deny(failure);};
  useEffect(() => {
    setSnapshot(undefined);
    document.getElementById('opencrawl-reload')?.remove();
  }, []);
  useEffect(() => {if (accessDenied) setInitialIntegrationsNav(false);}, [accessDenied]);
  const reportKeys: Record<string, readonly unknown[]> = {
    'console.team': consoleResourceKey(api.team), 'console.sources': consoleResourceKey(api.sources),
    'console.usage': consoleResourceKey(dataAdapter, 'usage'),
    'console.usageHighlights': consoleResourceKey(dataAdapter, 'usage-highlights'),
    'console.usageDetails': [...consoleResourceKey(dataAdapter, 'usage-details'), '30d'], ...extensions?.reloadKeys,
  };
  const seeds = data && data.cacheScope === snapshot?.bootstrap.cacheScope
    ? Object.entries(snapshot.reports).flatMap(([name, value]) => reportKeys[name] ? [{key:reportKeys[name], data:value}] : []) : [];
  const activated = async (signal: AbortSignal) => {
    const next = await refresh();
    if (!signal.aborted) navigate(next.setup || next.onboarding.completed ? '/' : next.onboarding.next);
  };
  const onboarding = location.pathname.startsWith('/onboarding');
  const machineSetup = data ? Boolean(data.setup) : document.getElementById('root')?.dataset.setupMode !== 'guided';
  const canSetUpReplicas = data?.workspace.role === 'admin' && data.canInstallReplicas === true && Boolean(api.replicasSetup);
  const extensionRoutes=extensions?.routes?.({data, activated}) ?? [];
  const routes: ConsoleRoute[] = [
    ...(machineSetup ? [{
      path:'/setup', label:'Setup', icon:'terminal' as const,
      badge:data?.setup?.installations.length === 0
        ? <span className="oc-nav-alert" role="img" aria-label="Needs attention. No computers connected." title="Connect your first computer">!</span>
        : undefined,
      element:data?.setup ? <SetupPage key={data.cacheScope} mcpUrl={data.mcpUrl} status={data.setup} error={error} apiKeys={data.workspace.role === 'admin' ? extensions?.computerApiKeys : undefined}/> : null,
      pending:(feedback?:ReactNode)=><PendingPage title="Setup">{feedback}</PendingPage>,
    }] : []),
    {path:'/',alternatePaths:usagePaths,label:'Usage',icon:'usage',element:<UsagePage showActivity={data?.searchActivity?data.cacheScope:undefined} adapter={dataAdapter} reportScope={data?.splitUsage ? data.cacheScope : undefined} setupPrompt={data?.setup ? undefined : data?.setupPrompt}/>,pending:feedback => <PendingPage bodyClassName="usage-report" title="Usage" description="Workspace usage">{feedback}</PendingPage>},
    ...extensionRoutes.filter(route=>route.group==='workspace'),
    {path:'/sessions/:permalinkId',navigation:false,label:'Session',element:<SessionsPage adapter={libraryAdapter}/>},
    {path:'/memories/:permalinkId',navigation:false,label:'Memory',element:<MemoriesPage adapter={libraryAdapter}/>},
    {path:'/sessions',label:'Sessions',icon:'sessions',element:<SessionsPage adapter={libraryAdapter}/>,pending:feedback => <PendingPage bodyClassName="oc-library" title="Sessions" description="Agent sessions captured across your workspace. Private sessions are visible only to the person who captured them.">{feedback}</PendingPage>},
    {path:'/memories',label:'Memories',icon:'memories',element:<MemoriesPage adapter={libraryAdapter}/>,pending:feedback => <PendingPage bodyClassName="oc-library" title="Memories" description="Memory files your agents keep, captured so teammates’ agents can use them.">{feedback}</PendingPage>},
    {path:'/sources',label:'Integrations',icon:'sources',navigation:data ? data.workspace.role === 'admin' : initialIntegrationsNav && !accessDenied,element:<SourcesPage adapter={api} canSetUpReplicas={canSetUpReplicas} canConfigure={data?.workspace.role === 'admin'}/>,pending:feedback => <PendingPage bodyClassName="oc-connections" title="Integrations" description="Connect your tools and OpenCrawl keeps their content in sync for your agents.">{feedback}</PendingPage>},
    {path:'/messages',alternatePaths:['/board/:workspace/channels/:value','/board/:workspace/posts/:value','/board/:workspace/threads/:value'],label:'Message board',icon:'diagnostics',element:<DiagnosticsPage adapter={dataAdapter} workspace={data?.boardWorkspace}/>,pending:feedback => <PendingPage title="Message board">{feedback}</PendingPage>},
    {path:'/search',label:'Search playground',icon:'search',element:<SearchPlaygroundPage adapter={dataAdapter}/>,pending:feedback => <PendingPage title="Search playground">{feedback}</PendingPage>},
    {path:'/agent-setup',label:'Agent setup',icon:'terminal',navigation:!machineSetup,element:data?.setup ? <Navigate to={'/setup' + location.hash} replace/> : data ? <AgentOnboarding key={data.cacheScope} adapter={onboardingAdapter} mcpUrl={data.mcpUrl} setupPrompt={data.setupPrompt} presentation="workspace"/> : null,pending:feedback => <PendingPage title="Agent setup">{feedback}</PendingPage>},
    {path:'/settings/team',label:'Team',icon:'team',group:'settings',element:<TeamPage embedded adapter={api} footer={extensions?.teamFooter} onWorkspaceRenamed={rename}/>,pending:feedback => <TeamLoadingPage embedded>{feedback}</TeamLoadingPage>},
    {path:'/settings/privacy',label:'Privacy',group:'settings',element:<div key={data?.cacheScope} className="oc-management-page">
      <RecordingSettings adapter={libraryAdapter}/>
      {data?.sessionPrivacy && <PrivacySettings adapter={libraryAdapter}/>}
    </div>,pending:feedback => feedback ?? <LoadingState label="Loading privacy settings"/>},
    ...extensionRoutes.filter(route=>route.group!=='workspace'),
    {path:'/settings',label:'Settings',navigation:false,element:<Navigate to={'/settings/team' + location.search + location.hash} replace/>,pending:() => <Navigate to={'/settings/team' + location.search + location.hash} replace/>},
    {path:'/team',label:'Team',navigation:false,element:<Navigate to={'/settings/team' + location.search + location.hash} replace/>,pending:() => <Navigate to={'/settings/team' + location.search + location.hash} replace/>},
    {path:'/integrations',label:'Integrations',navigation:false,element:<Navigate to={'/sources' + location.hash} replace/>},
    {path:'/data',label:'Data controls',navigation:false,element:<Navigate to="/sources#data-controls" replace/>},
    {path:'/diagnostics',label:'Message board',navigation:false,element:<Navigate to={'/messages' + location.search + location.hash} replace/>},
    {path:'/_/debug',label:'Diagnostics',navigation:false,element:<Navigate to={'/messages' + location.search + location.hash} replace/>},
  ];
  if (!data) {
    const feedback = error ? <div className="stack"><Notice tone="danger">{error}</Notice><div className="action-row"><Button onClick={retry}>Try again</Button><LinkButton to="/auth/login" reloadDocument>Sign in</LinkButton></div></div> : undefined;
    if (onboarding) return <FocusedFrame footer={<SignOut/>}>{feedback ?? <Page title="Set up OpenCrawl"><LoadingState label="Loading your workspace"/></Page>}</FocusedFrame>;
    const route = routes.find(item => matchesConsoleRoute(item,location.pathname));
    return <AppShell workspace={{name:'Workspace'}} routes={routes} footer={<SignOut/>}>{route?.pending?.(feedback) ?? <PendingPage title={route?.label ?? 'Workspace'}>{feedback}</PendingPage>}</AppShell>;
  }
  if (location.hash === '#replicas-capture' && ['/setup', '/agent-setup', '/sources'].includes(location.pathname)) return <Navigate to={replicasAgentSetupPath} replace/>;
  if (data.setup && onboarding) return <Navigate to="/setup" replace/>;
  if (!data.setup && !data.onboarding.completed && !onboarding) return <Navigate to={data.onboarding.next} replace/>;
  if (onboarding && data.workspace.role !== 'admin' && location.pathname !== '/onboarding') return data.onboarding.completed ? <Navigate to="/" replace/> : <FinishMemberOnboarding api={api} onComplete={async () => {await refresh();navigate('/');}}/>;
  if (onboarding) return <ConsoleDataProvider scopeKey={data.cacheScope} onAccessFailure={invalidateAccess}><FocusedFrame footer={<SignOut/>}><Routes>
    <Route path="/onboarding" element={<AgentOnboarding adapter={onboardingAdapter} mcpUrl={data.mcpUrl} setupPrompt={data.setupPrompt} canInviteBeforeSetup={data.canInvite && data.invitationPolicy?.beforeAgentSetup}/>}/>
    <Route path="/onboarding/sources" element={<SourcesOnboarding adapter={onboardingAdapter} canConfigure={data.workspace.role === 'admin'}/>}/>
    <Route path="/onboarding/invite" element={<InviteOnboarding adapter={onboardingAdapter} canInvite={data.canInvite} invitationDelivery={data.invitationPolicy?.delivery} returnToAgent={Boolean(data.invitationPolicy?.beforeAgentSetup && !data.onboarding.completed && data.onboarding.next === '/onboarding')} onComplete={async path => {await refresh();navigate(path);}}/>}/>
  </Routes></FocusedFrame></ConsoleDataProvider>;
  const shown = extensions?.decorateRoute ? routes.map(route => extensions.decorateRoute!(route, data)) : routes;
  return <ConsoleDataProvider scopeKey={data.cacheScope} initial={seeds} onAccessFailure={invalidateAccess}><WorkspaceInvalidation/><AppShell workspace={data.workspace} workspaceNotice={extensions?.workspaceNotice?.(data)} routes={shown} footer={<SignOut/>}/></ConsoleDataProvider>;
}
/** Members finish their personal setup without entering workspace administration. */
function FinishMemberOnboarding({api,onComplete}:{api:Pick<ProductApi,'finishOnboarding'>;onComplete:()=>Promise<void>}) {
  const [attempt,setAttempt]=useState(0),[error,setError]=useState('');
  const navigate=useNavigate();
  const complete=useRef(onComplete);complete.current=onComplete;
  useEffect(()=>{
    const controller=new AbortController();setError('');
    void api.finishOnboarding(controller.signal).then(async()=>{if(!controller.signal.aborted)await complete.current();}).catch(failure=>{if(controller.signal.aborted)return;if(failure instanceof Error && 'status' in failure && failure.status===409){navigate('/onboarding',{replace:true});return;}setError(failure instanceof Error?failure.message:'Setup could not finish. Try again.');});
    return()=>controller.abort();
  },[api,attempt,navigate]);
  return <FocusedFrame footer={<SignOut/>}>{error ? <><Notice tone="danger">{error}</Notice><Button onClick={()=>setAttempt(value=>value+1)}>Try again</Button></> : <LoadingState label="Opening your workspace"/>}</FocusedFrame>;
}
/** One application composition for self-hosted and hosted deployments. */
export function OpenCrawlApp<B extends Bootstrap>({api, extensions}: {api: ProductApi<B>; extensions?: ConsoleExtensions<B>}) {
  return <AppRouter><ErrorBoundary><ApplicationContent api={api} extensions={extensions}/></ErrorBoundary></AppRouter>;
}
function ApplicationContent<B extends Bootstrap>({api,extensions}: {api:ProductApi<B>;extensions?:ConsoleExtensions<B>}) {
  const [page] = useState(readBrowserDocument);
  return page ? <DocumentFrame signedIn={page.signedIn} frame={page.frame}>{extensions?.document?.(page.page) ?? <ProductDocument page={page.page}/>}</DocumentFrame> : <ConsoleApp api={api} extensions={extensions}/>;
}
