/** Browser-test fixture only. It is never a product entrypoint or published asset. */
import {OpenCrawlApp} from '../../src/application/app.tsx';
import {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentOnboarding, AppRouter, AppShell, Button, ConsoleDataProvider, FocusedFrame, InviteOnboarding, Page, Route, Routes, SourcesOnboarding, SourcesPage, useLocation, useNavigate, type OnboardingAdapter} from '../../src/index.ts';
import {CopyPromptButton} from '../../src/onboarding/copy.tsx';
import type {TeamAdapter, SourcesAdapter, ProductApi, Bootstrap} from '../../src/application/api.ts';
import '../../src/styles.css';
import {TeamPage} from '../../src/application/team.tsx';
import {ConsoleApiError} from '../../src/application/errors.ts';
import {DocumentFrame,ProductDocument} from '../../src/application/documents.tsx';
import {CallbackChoices, readContinuation} from '../../src/application/callback-view.tsx';
import {SessionsPage} from '../../src/pages/sessions.tsx';
import type {LibraryAdapter} from '../../src/pages/library-types.ts';
import {UsagePage} from '../../src/pages/usage.tsx';
import {usagePaths} from '../../../src/application/usage-paths.mjs';
import {DailyBarChart, PageHeader} from '../../src/design/components.tsx';
import {DiagnosticsPage, SearchPlaygroundPage} from '../../src/pages/diagnostics.tsx';
import type {ConsoleDataAdapter} from '../../src/pages/types.ts';

declare global {
  interface Window {__onboardingTestNavigate?: (path: string) => void;}
}

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, {signal, method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const value: unknown = await response.json();
  if (!response.ok) throw new ConsoleApiError(typeof value === 'object' && value && 'error' in value ? typeof value.error==='object'&&value.error&&'message' in value.error?String(value.error.message):String(value.error) : 'Request failed', response.status);
  return value as T;
}
const adapter: OnboardingAdapter = {
  replicasSetup: async () => ({prompt:'Install OpenCrawl in this Replicas environment for my team. Use workspace_identity and verify shared capture.',expiresAt:new Date(Date.now()+1800000).toISOString()}),
  status: signal => request('/api/onboarding', signal),
  sources: signal => request('/api/onboarding/sources', signal),
  connectSource: (id, body, signal) => request(`/api/integrations/${encodeURIComponent(id)}/connect`, signal, body),
  saveCredential: (id, value, signal) => request(`/api/integrations/credentials/${encodeURIComponent(id)}`, signal, {value}),
  invitations: signal => request('/api/onboarding/invites', signal),
  invite: (email, signal) => request('/api/onboarding/invites', signal, {email}),
  finish: signal => request('/api/onboarding/finish', signal, {}),
};
const never = new AbortController().signal;
const usageAdapter: ConsoleDataAdapter = {usage: signal => request('/api/console/usage', signal), search: async () => ({}), board: async () => ({messages: [], topicSummaries: [], next: null})};
const progressiveUsageAdapter: ConsoleDataAdapter = {...usageAdapter,
  callTotals:(range,signal,basis)=>request('/api/console/usage/calls',signal,{range,basis}),
  usageTokens:(range,signal,basis)=>request('/api/console/usage/tokens',signal,{range,basis}),
  tokenSessions:(input,signal)=>request('/api/console/usage/token-sessions',signal,input),
  searchHistory:(input,signal)=>request('/api/console/usage/search-history',signal,input),
  usageHighlights: signal => request('/api/console/usage/highlights', signal),
  usageDetails: (signal, range = '30d') => request('/api/console/usage/details', signal, {range}),
};
const diagnosticsAdapter: ConsoleDataAdapter = {...usageAdapter, boardDestination:(path,signal)=>request('/api/console/board-target?'+new URLSearchParams({path}),signal), search:(query,signal,page)=>request('/api/debug/search',signal,{query,page}), board: (input, signal) => request('/api/console/board?' + new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)])), signal)};
const selfhostSetup = new URLSearchParams(window.location.search).has('selfhost');
const libraryAdapter: LibraryAdapter = (operation, input, signal) => request('/api/library/' + operation, signal, input);
/** The Integrations page against the same fixture state as the onboarding step. */
const sourcesAdapter: SourcesAdapter = {
  replicasHistory:(input,signal)=>request('/api/integrations/replicas/history',signal??never,input),
  devinRecording:(input,signal)=>request('/api/integrations/devin/recording',signal??never,input),
  sources: signal => request('/api/console/sources', signal ?? never),
  connect: (provider, apiKey, signal) => request(`/api/integrations/${encodeURIComponent(provider)}/connect`, signal ?? never, {apiKey}),
  retry: async () => ({ok: true}), disconnect: async () => ({ok: true}),
  saveCredential: (id, value, signal) => request(`/api/integrations/credentials/${encodeURIComponent(id)}`, signal ?? never, {value}),
};
const teamAdapter: TeamAdapter = {team: signal => request('/api/console/team', signal ?? never), invite: (email,signal) => request('/api/console/team/invite',signal ?? never,{email}), changeRole: async (userId,role) => ({ok:true,userId,role}), renameOrganization: async name => ({ok:true,name}), removeMember: (userId,signal) => request('/api/console/team/remove',signal ?? never,{userId})};
const fullApi: ProductApi = {
  replicasSetup:signal=>request('/api/console/replicas/setup',signal,{}),
  ...sourcesAdapter,...teamAdapter,...diagnosticsAdapter,library:libraryAdapter,
  bootstrap:signal=>request<Bootstrap>('/api/console/bootstrap',signal??never),
  onboardingStatus:async signal=>({data:await adapter.status(signal??never)}),
  onboardingSources:adapter.sources,onboardingInvitations:adapter.invitations,onboardingInvite:adapter.invite,finishOnboarding:adapter.finish,
};
export const setupPrompt = 'Set up OpenCrawl across all coding agents and environments I use. Inspect existing setup, reuse valid configuration and authentication, and complete what is missing. Keep credentials out of chats and repositories. Confirm recording and history import consent, then verify a newly recorded session.';
const account = <form className="header-account" method="post" action="/auth/logout"><Button variant="quiet" type="submit">Sign out</Button></form>;

function Fixture() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {window.__onboardingTestNavigate = path => {void navigate(path);}; return () => {delete window.__onboardingTestNavigate;};}, [navigate]);
  if (usagePaths.includes(location.pathname)) return <ConsoleDataProvider scopeKey="usage-fixture" onAccessFailure={() => {}}><AppShell workspace={{name: 'Example workspace', userName: 'Alex', role: 'Admin'}} routes={[{path: '/usage', alternatePaths:usagePaths.filter(path => path !== '/usage'), label: 'Usage', icon: 'usage', element: <UsagePage showActivity={new URLSearchParams(location.search).has('activity')?'usage-fixture':undefined} adapter={progressiveUsageAdapter} reportScope={new URLSearchParams(location.search).has('split') ? 'usage-fixture' : undefined}/>}]}/></ConsoleDataProvider>;
  if (location.pathname === '/stacked-usage-fixture') return <DailyBarChart label="Items per day" xAxisLabel="Date (UTC)" yAxisLabel="Items"
    days={[{date:'2026-11-17',value:10,segments:[2,3,5]},{date:'2026-11-18',value:0,segments:[0,0,0]},
      {date:'2026-11-19',value:null},{date:'2026-11-20',value:9,segments:[8,1,0]}]}
    series={[{label:'Sessions'},{label:'Documents'},{label:'Memories'}]} unit={n=>n+' items'}/>;
  if (location.pathname.startsWith('/board/') || location.pathname === '/messages' || location.pathname === '/search') {
    return <ConsoleDataProvider scopeKey="diagnostics-fixture" onAccessFailure={() => {}}><AppShell workspace={{name: 'Example workspace', userName: 'Alex', role: 'Admin'}} routes={[{path: '/messages', alternatePaths:['/board/:workspace/:kind/:value'], label: 'Message board', icon: 'diagnostics', element: <DiagnosticsPage adapter={diagnosticsAdapter} workspace={location.pathname.startsWith('/board/') || new URLSearchParams(location.search).has('links') ? 'fixtureboard' : undefined} canInspect/>}, {path: '/search', label: 'Search playground', icon: 'search', element: <SearchPlaygroundPage adapter={diagnosticsAdapter} canInspect/>}]}/></ConsoleDataProvider>;
  }
  if (location.pathname === '/sessions' || location.pathname.startsWith('/sessions/')) return <ConsoleDataProvider scopeKey="session-fixture" onAccessFailure={() => {}}><AppShell workspace={{name:'Example workspace',userName:'Alex',role:'Admin'}} routes={[
    {path:'/sessions',label:'Sessions',icon:'sessions',element:<SessionsPage adapter={libraryAdapter}/>},
    {path:'/sessions/:permalinkId',navigation:false,label:'Session',element:<SessionsPage adapter={libraryAdapter}/>},
  ]}/></ConsoleDataProvider>;
  if (location.pathname === '/integrations-fixture') return <ConsoleDataProvider scopeKey="fixture" onAccessFailure={() => {}}><AppShell workspace={{name:'Example workspace',userName:'Alex',role:'Admin'}} routes={[{path:'/integrations-fixture',label:'Integrations',icon:'sources',element:location.search.includes('decorated')
      ? <div className="stack"><div className="stack"><SourcesPage adapter={sourcesAdapter} canConfigure/><p><a href="#connector-terms" id="connector-terms">Connector terms</a></p></div></div>
      : <SourcesPage adapter={sourcesAdapter} canConfigure={!location.search.includes('role=member')}/>}]}/></ConsoleDataProvider>;
  if (location.pathname.startsWith('/workspace')) return <AppShell
    workspace={{name: 'Example workspace', userName: 'Alex', email: 'alex@example.test', role: 'Admin'}}
    routes={[
      {path: '/workspace', label: 'Usage', icon: 'usage', end: true, element: <h1 tabIndex={-1} data-page-heading>Console home</h1>},
      {path: '/workspace/settings', label: 'Agent setup', icon: 'settings', element: <AgentOnboarding adapter={adapter} mcpUrl="https://app.getopencrawl.com/mcp" setupPrompt={setupPrompt} presentation="workspace"/>},
      {path: '/workspace/team', label: 'Team', icon: 'team', group: 'manage', element: <h1 tabIndex={-1} data-page-heading>Console team</h1>},
      {path: '/workspace/prompt', label: 'Usage', navigation: false, element: <Page title="Usage" description="Example workspace" actions={<CopyPromptButton text={setupPrompt} manualPath="/workspace/settings"/>}/>},
    ]}
    footer={<Button variant="quiet" onClick={() => {void navigate('/away');}}>Sign out</Button>}
  />;
  return <Routes>
    <Route path="/signed-out" element={<DocumentFrame signedIn={false}><ProductDocument page={{kind:'message',heading:'You’re signed out',detail:'You have signed out of OpenCrawl.',href:'/auth/login',action:'Sign in'}}/></DocumentFrame>}/>
    <Route path="/team-fixture" element={<ConsoleDataProvider scopeKey="team-fixture" onAccessFailure={() => {}}><TeamPage adapter={teamAdapter}/></ConsoleDataProvider>} />
    <Route path="/auth-fixture/claude-return" element={<DocumentFrame signedIn><ProductDocument page={{kind:'oauth-return',url:'claude://claude.ai/mcp-auth-callback/sdk?code=example&state=bound'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/imprint" element={<DocumentFrame signedIn={false} frame="imprint"><section className="oc-imprint-content"><PageHeader title="Welcome to OpenCrawl"/><Button>Continue</Button></section></DocumentFrame>}/>
    <Route path="/auth-fixture/login" element={<DocumentFrame signedIn={false}><ProductDocument page={{kind:'auth',view:'login',next:'/device?user_code=TEST-1234'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/login-error" element={<DocumentFrame signedIn={false}><ProductDocument page={{kind:'auth',view:'login',error:'The email or password is incorrect. Try again.'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/join" element={<DocumentFrame signedIn={false}><ProductDocument page={{kind:'auth',view:'join',email:'alex@example.com',invitation:'private-invitation'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/device" element={<DocumentFrame signedIn><ProductDocument page={{kind:'auth',view:'device',code:'TEST-1234'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/setup" element={<DocumentFrame signedIn={false}><ProductDocument page={{kind:'auth',view:'setup',setup:'private-once-only'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/consent" element={<DocumentFrame signedIn><ProductDocument page={{kind:'auth',view:'consent',clientName:'Example MCP client',oauthQuery:'signed-consent-query',resource:'https://oss.example/mcp',scopes:['openid','offline_access']}}/></DocumentFrame>}/>

    <Route path="/callback-selection" element={<CallbackChoices model={readContinuation(JSON.stringify({name:'GitHub',returnTo:'/onboarding/sources',actions:[{label:'Connect first account',url:'https://github.com/login/oauth/authorize?client_id=owned&state=bound.42'},{label:'Connect second account',url:'https://github.com/login/oauth/authorize?client_id=owned&state=bound.43'},{label:'Install for another account',url:'https://github.com/apps/owned-app/installations/new?state=bound'}]}))}/>} />
    <Route path="/onboarding" element={<FocusedFrame footer={account}><AgentOnboarding adapter={adapter} mcpUrl="https://app.getopencrawl.com/mcp" setupPrompt={setupPrompt} canInviteBeforeSetup={selfhostSetup} /></FocusedFrame>} />
    <Route path="/onboarding/sources" element={<FocusedFrame footer={account}><SourcesOnboarding adapter={adapter} canConfigure={!location.search.includes('role=member')} /></FocusedFrame>} />

    <Route path="/onboarding/invite" element={<FocusedFrame footer={account}><InviteOnboarding adapter={adapter} canInvite={!location.search.includes('role=member')} returnToAgent={selfhostSetup} invitationDelivery={selfhostSetup?'link':'email'} /></FocusedFrame>} />
    <Route path="/" element={<h1>Workspace overview</h1>} />
    <Route path="/away" element={<h1>Different route</h1>} />
  </Routes>;
}
const mount = document.getElementById('root');
if (!mount) throw new Error('Fixture mount is missing');
createRoot(mount).render(new URLSearchParams(window.location.search).has('full-app') ? <OpenCrawlApp api={fullApi}/> : <AppRouter><Fixture /></AppRouter>);
