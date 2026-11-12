/** Browser-test fixture only. It is never a product entrypoint or published asset. */
import {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentOnboarding, AppRouter, AppShell, Button, ConsoleDataProvider, FocusedFrame, InviteOnboarding, Route, Routes, SourcesOnboarding, SourcesPage, useLocation, useNavigate, type OnboardingAdapter} from '../../src/index.ts';
import type {TeamAdapter, SourcesAdapter} from '../../src/application/api.ts';
import '../../src/styles.css';
import {TeamPage} from '../../src/application/team.tsx';
import {ConsoleApiError} from '../../src/application/errors.ts';
import {DocumentFrame,ProductDocument} from '../../src/application/documents.tsx';
import {CallbackChoices, readContinuation} from '../../src/application/callback-view.tsx';
import {SessionsPage} from '../../src/pages/sessions.tsx';
import type {LibraryAdapter} from '../../src/pages/library-types.ts';

declare global {
  interface Window {__onboardingTestNavigate?: (path: string) => void;}
}

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, {signal, method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const value: unknown = await response.json();
  if (!response.ok) throw new ConsoleApiError(typeof value === 'object' && value && 'error' in value ? String(value.error) : 'Request failed', response.status);
  return value as T;
}
const adapter: OnboardingAdapter = {
  status: signal => request('/api/onboarding', signal),
  sources: signal => request('/api/onboarding/sources', signal),
  connectSource: (id, body, signal) => request(`/api/integrations/${encodeURIComponent(id)}/connect`, signal, body),
  saveCredential: (id, value, signal) => request(`/api/integrations/credentials/${encodeURIComponent(id)}`, signal, {value}),
  invitations: signal => request('/api/onboarding/invites', signal),
  invite: (email, signal) => request('/api/onboarding/invites', signal, {email}),
  finish: signal => request('/api/onboarding/finish', signal, {}),
};
const never = new AbortController().signal;
const selfhostSetup = new URLSearchParams(window.location.search).has('selfhost');
const libraryAdapter: LibraryAdapter = (operation, input, signal) => request('/api/library/' + operation, signal, input);
/** The Integrations page against the same fixture state as the onboarding step. */
const sourcesAdapter: SourcesAdapter = {
  sources: signal => request('/api/console/sources', signal ?? never),
  connect: (provider, apiKey, signal) => request(`/api/integrations/${encodeURIComponent(provider)}/connect`, signal ?? never, {apiKey}),
  retry: async () => ({ok: true}), disconnect: async () => ({ok: true}),
  saveCredential: (id, value, signal) => request(`/api/integrations/credentials/${encodeURIComponent(id)}`, signal ?? never, {value}),
};
const teamAdapter: TeamAdapter = {team: signal => request('/api/console/team', signal ?? never), invite: (email,signal) => request('/api/console/team/invite',signal ?? never,{email}), changeRole: async (userId,role) => ({ok:true,userId,role}), renameOrganization: async name => ({ok:true,name}), removeMember: (userId,signal) => request('/api/console/team/remove',signal ?? never,{userId})};
export const setupPrompt = 'Set up OpenCrawl across all coding agents and environments I use. Inspect existing setup, reuse valid configuration and authentication, and complete what is missing. Keep credentials out of chats and repositories. Confirm recording and history import consent, then verify a newly recorded session.';
const account = <form className="header-account" method="post" action="/auth/logout"><Button variant="quiet" type="submit">Sign out</Button></form>;

function Fixture() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {window.__onboardingTestNavigate = path => {void navigate(path);}; return () => {delete window.__onboardingTestNavigate;};}, [navigate]);
  if (location.pathname === '/sessions') return <ConsoleDataProvider scopeKey="session-fixture" onAccessFailure={() => {}}><AppShell workspace={{name: 'Example workspace', userName: 'Alex', role: 'Admin'}} routes={[{path: '/sessions', label: 'Sessions', icon: 'sessions', element: <SessionsPage adapter={libraryAdapter}/>}]}/></ConsoleDataProvider>;
  if (location.pathname === '/integrations-fixture') return <ConsoleDataProvider scopeKey="fixture" onAccessFailure={() => {}}><AppShell workspace={{name:'Example workspace',userName:'Alex',role:'Admin'}} routes={[{path:'/integrations-fixture',label:'Integrations',icon:'sources',element:<SourcesPage adapter={sourcesAdapter} canConfigure={!location.search.includes('role=member')}/>}]}/></ConsoleDataProvider>;
  if (location.pathname.startsWith('/workspace')) return <AppShell
    workspace={{name: 'Example workspace', userName: 'Alex', email: 'alex@example.test', role: 'Admin'}}
    routes={[
      {path: '/workspace', label: 'Usage', icon: 'usage', end: true, element: <h1 tabIndex={-1} data-page-heading>Console home</h1>},
      {path: '/workspace/settings', label: 'Agent setup', icon: 'settings', element: <AgentOnboarding adapter={adapter} mcpUrl="https://app.getopencrawl.com/mcp" setupPrompt={setupPrompt} presentation="workspace"/>},
      {path: '/workspace/team', label: 'Team', icon: 'team', group: 'manage', element: <h1 tabIndex={-1} data-page-heading>Console team</h1>},
    ]}
    footer={<Button variant="quiet" onClick={() => {void navigate('/away');}}>Sign out</Button>}
  />;
  return <Routes>
    <Route path="/team-fixture" element={<ConsoleDataProvider scopeKey="team-fixture" onAccessFailure={() => {}}><TeamPage adapter={teamAdapter}/></ConsoleDataProvider>} />
    <Route path="/auth-fixture/claude-return" element={<DocumentFrame signedIn><ProductDocument page={{kind:'oauth-return',url:'claude://claude.ai/mcp-auth-callback/sdk?code=example&state=bound'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/setup" element={<DocumentFrame signedIn={false}><ProductDocument page={{kind:'auth',view:'setup',setup:'private-once-only'}}/></DocumentFrame>}/>
    <Route path="/auth-fixture/consent" element={<DocumentFrame signedIn><ProductDocument page={{kind:'auth',view:'consent',clientName:'Example MCP client',oauthQuery:'signed-consent-query',resource:'https://oss.example/mcp',scopes:['openid','offline_access']}}/></DocumentFrame>}/>

    <Route path="/callback-selection" element={<CallbackChoices model={readContinuation(JSON.stringify({name:'GitHub',returnTo:'/onboarding/sources',actions:[{label:'Connect first account',url:'https://github.com/login/oauth/authorize?client_id=owned&state=bound.42'},{label:'Connect second account',url:'https://github.com/login/oauth/authorize?client_id=owned&state=bound.43'},{label:'Install for another account',url:'https://github.com/apps/owned-app/installations/new?state=bound'}]}))}/>} />
    <Route path="/onboarding" element={<FocusedFrame footer={account}><AgentOnboarding adapter={adapter} mcpUrl="https://app.getopencrawl.com/mcp" setupPrompt={setupPrompt} canInviteBeforeSetup={selfhostSetup} /></FocusedFrame>} />
    <Route path="/onboarding/sources" element={<FocusedFrame footer={account}><SourcesOnboarding adapter={adapter} canConfigure={!location.search.includes('role=member')} /></FocusedFrame>} />

    <Route path="/onboarding/invite" element={<FocusedFrame footer={account}><InviteOnboarding adapter={adapter} canInvite returnToAgent={selfhostSetup} invitationDelivery={selfhostSetup?'link':'email'} /></FocusedFrame>} />
    <Route path="/" element={<h1>Workspace overview</h1>} />
    <Route path="/away" element={<h1>Different route</h1>} />
  </Routes>;
}
const mount = document.getElementById('root');
if (!mount) throw new Error('Fixture mount is missing');
createRoot(mount).render(<AppRouter><Fixture /></AppRouter>);
