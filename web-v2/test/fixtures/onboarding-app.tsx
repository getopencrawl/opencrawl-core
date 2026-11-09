/** Browser-test fixture only. It is never a product entrypoint or published asset. */
import {useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {AgentOnboarding, AppRouter, AppShell, Button, FocusedFrame, InviteOnboarding, Route, Routes, SourcesOnboarding, useLocation, useNavigate, type OnboardingAdapter} from '../../src/index.ts';
import '../../src/styles.css';

declare global {
  interface Window {__onboardingTestNavigate?: (path: string) => void;}
}

async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, {signal, method: body === undefined ? 'GET' : 'POST', headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(typeof value === 'object' && value && 'error' in value ? String(value.error) : 'Request failed');
  return value as T;
}
const adapter: OnboardingAdapter = {
  status: signal => request('/api/onboarding', signal),
  sources: signal => request('/api/onboarding/sources', signal),
  connectSource: (id, body, signal) => request(`/api/integrations/${encodeURIComponent(id)}/connect`, signal, body),
  invitations: signal => request('/api/onboarding/invites', signal),
  invite: (email, signal) => request('/api/onboarding/invites', signal, {email}),
  finish: signal => request('/api/onboarding/finish', signal, {}),
};
export const setupPrompt = 'Set up OpenCrawl across all coding agents and environments I use. Inspect existing setup, reuse valid configuration and authentication, and complete what is missing. Keep credentials out of chats and repositories. Confirm recording and history import consent, then verify a newly recorded session.';
const account = <form className="header-account" method="post" action="/auth/logout"><Button variant="quiet" type="submit">Sign out</Button></form>;

function Fixture() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {window.__onboardingTestNavigate = path => {void navigate(path);}; return () => {delete window.__onboardingTestNavigate;};}, [navigate]);
  if (location.pathname.startsWith('/workspace')) return <AppShell
    workspace={{name: 'Example workspace', userName: 'Alex', email: 'alex@example.test', role: 'Admin'}}
    routes={[
      {path: '/workspace', label: 'Usage', icon: 'usage', end: true, element: <h1 tabIndex={-1} data-page-heading>Console home</h1>},
      {path: '/workspace/team', label: 'Team', icon: 'team', element: <h1 tabIndex={-1} data-page-heading>Console team</h1>},
    ]}
    footer={<Button variant="quiet" onClick={() => {void navigate('/away');}}>Sign out</Button>}
  />;
  return <Routes>
    <Route path="/onboarding" element={<FocusedFrame footer={account}><AgentOnboarding adapter={adapter} mcpUrl="https://app.getopencrawl.com/mcp" setupPrompt={setupPrompt} /></FocusedFrame>} />
    <Route path="/onboarding/sources" element={<FocusedFrame footer={account}><SourcesOnboarding adapter={adapter} /></FocusedFrame>} />
    <Route path="/onboarding/invite" element={<FocusedFrame footer={account}><InviteOnboarding adapter={adapter} canInvite /></FocusedFrame>} />
    <Route path="/" element={<h1>Workspace overview</h1>} />
    <Route path="/away" element={<h1>Different route</h1>} />
  </Routes>;
}
const mount = document.getElementById('root');
if (!mount) throw new Error('Fixture mount is missing');
createRoot(mount).render(<AppRouter><Fixture /></AppRouter>);
