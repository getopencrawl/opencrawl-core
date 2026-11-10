import {useEffect, type ReactNode} from 'react';
import {z} from 'zod';
import {productPageSchema, type CallbackPage, type CapturePage} from '../../../src/application/page-types.mjs';
import {Button, Field, Input, LinkButton, Notice, Page, Textarea} from '../design/components.tsx';
import {FocusedFrame} from '../design/focused-frame.tsx';
import {CallbackChoices, readContinuation} from './callback-view.tsx';
import {AuthDocument} from './auth-document.tsx';

export function readBrowserDocument() {
  const element = document.getElementById('opencrawl-page');
  if (!element) return null;
  const result = z.object({signedIn:z.boolean(),page:z.unknown()}).parse(JSON.parse(element.textContent || ''));
  // Capture setup may carry a credential. Remove its inert bootstrap after reading.
  element.remove();
  return result;
}
export function DocumentFrame({signedIn,children}: {signedIn:boolean;children:ReactNode}) {
  return <FocusedFrame reloadHome footer={signedIn ? <form method="post" action="/auth/logout"><Button type="submit" variant="quiet">Sign out</Button></form> : undefined}><main id="main" className="oc-document">{children}</main></FocusedFrame>;
}
function CallbackDocument({page}: {page:CallbackPage}) {
  const choosing = Boolean(page.actions?.length);
  useEffect(() => {
    if (choosing || !window.opener) return;
    window.opener.postMessage({type:'opencrawl:integrations',ok:page.ok},window.location.origin);
    if (page.ok) window.close();
  },[page.ok,choosing]);
  if (choosing) return <CallbackChoices model={readContinuation(JSON.stringify(page))}/>;
  const onboarding = page.returnTo === '/onboarding/sources';
  const heading = page.reason === 'repositories' ? 'No accessible repositories' : page.ok ? `${page.name} is connected` : page.reason === 'declined' ? `${page.name} wasn’t connected` : onboarding ? 'Try connecting again' : page.reason === 'taken' ? `Your team already connected ${page.name}` : 'This link has expired';
  const detail = page.reason === 'repositories' ? 'Ask your GitHub administrator to grant this App and your account access to the repositories, then connect again.' : onboarding ? (page.ok ? 'Your import has started. Return to your sources to continue setup.' : 'Your other connections are saved. Return to your sources and try again.') : page.ok ? 'Your import has started. You can close this window.' : page.reason === 'taken' ? 'A teammate connected it first, so there’s nothing more to do.' : 'Return to Sources and try connecting again.';
  return <Page title={heading} description={detail}><div><LinkButton to={page.returnTo} reloadDocument>Continue</LinkButton></div></Page>;
}
function CaptureDocument({page}: {page:CapturePage}) {
  return <Page title="Capture Claude cloud sessions" description="Use a personal Claude cloud environment. Every session using this credential is shared with your OpenCrawl team and attributed to you; do not put it in a shared environment.">
    {page.revoked && <Notice tone="success">Capture credential revoked.</Notice>}
    {page.credential ? <>
      <p>This upload-only credential expires {page.credential.expiresAt.slice(0,10)}. It cannot search or read sessions. Copy it into Claude’s environment variables; keep it out of chats and repositories.</p>
      <Field label="Environment variable"><Textarea rows={3} readOnly value={'OPENCRAWL_SESSIONS_TOKEN='+page.credential.token}/></Field>
      <p>Credential ID: <code>{page.credential.id}</code>. Save this ID to revoke access later.</p>
    </> : <form method="post" action="/capture/cloud"><Button type="submit" variant="primary">Create upload-only credential</Button></form>}
    <ol className="oc-document-steps">
      <li>At claude.ai/code, open the environment selector and create or edit a personal environment.</li>
      <li>Under Network access, keep Limited/Trusted access and add <code>{new URL(page.api).hostname}</code>. Keep npm/package registries allowed.</li>
      <li>Under Environment variables, add the credential above. Values are readable by sessions in this environment.</li>
      <li>Append this script to Setup script (preserve any existing setup), then save changes.</li>
      <li>Start a new session with that environment selected. Ask it to run a shell command, read an attached image, and check <code>opencrawl collect status</code> using the installed path below. A stored receipt confirms upload; search appears after asynchronous indexing.</li>
    </ol>
    <Field label="Setup script"><Textarea rows={10} readOnly value={page.script}/></Field>
    <p>CLI path: <code>$HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl</code>. Your current setup session may need a restart; future sessions prepare capture in the setup script and authenticate in a supervised asynchronous hook when Claude starts. Capture includes messages, tool arguments/results and attachments. System prompt snapshots are omitted.</p>
    <h2>Capture Grok Bot sessions</h2>
    <p>Your Bots share one cloud computer, so one installation there captures all of them, attributed to you. Use your own computer, never a shared Bot’s.</p>
    <ol className="oc-document-steps">
      <li>Ask a Bot to run this on its computer: <code>{'npm i -g @getopencrawl/cli@next && opencrawl collect install --yes --harness grok-bot --defer-auth --api '+page.api}</code></li>
      <li>Sign in on that computer with <code>{'opencrawl login --no-browser --api '+page.api}</code> and approve it in your browser. To keep the computer upload-only instead, create the credential above and enter it as <code>OPENCRAWL_SESSIONS_TOKEN</code> in the secure secret card the Bot shows you, never in the chat.</li>
      <li>Bots that are already running may keep their earlier hooks. From a newly created Bot, run a command, then ask it for <code>opencrawl collect status</code>: a stored receipt confirms upload.</li>
    </ol>
    <form method="post" action="/capture/cloud/revoke" className="stack"><Field label="Credential ID to revoke"><Input name="id" pattern="[a-f0-9]{64}" required defaultValue={page.credential?.id ?? ''}/></Field><div><Button type="submit">Revoke credential</Button></div></form>
  </Page>;
}
export function ProductDocument({page}: {page:unknown}) {
  const data = productPageSchema.parse(page);
  if (data.kind === 'integration-callback') return <CallbackDocument page={data}/>;
  if (data.kind === 'capture') return <CaptureDocument page={data}/>;
  if (data.kind === 'auth') return <AuthDocument page={data}/>;
  if (data.kind === 'oauth-return') return <OAuthReturn url={data.url}/>;
  return <Page title={data.heading} description={data.detail}><div><LinkButton to={data.href} reloadDocument>{data.action}</LinkButton></div></Page>;
}
function OAuthReturn({url}: {url:string}) {
  useEffect(()=>{window.location.assign(url);},[url]);
  return <Page title="Returning to your app"><LinkButton to={url} reloadDocument>Continue</LinkButton></Page>;
}
