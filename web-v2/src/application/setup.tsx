import {useEffect,useMemo,useRef,useState} from 'react';
import {Button, CopyField, EmptyState, LinkButton, LoadingState, Notice, Page, Section, StatusBadge} from '../design/components.tsx';
import {consoleResourceKey, useConsoleResource} from '../data.tsx';
import type {SetupStatus} from '../../../src/application/types.mjs';
import type {ProductApi} from './api.ts';
import {copyText} from '../onboarding/copy.tsx';

type Client = SetupStatus['installations'][number]['clients'][number];
const clientNames: Readonly<Record<string,string>> = {'claude-code':'Claude Code',codex:'Codex',cursor:'Cursor',antigravity:'Antigravity',agy:'Antigravity'};
export const clientName = (client:string) => clientNames[client] ?? client;
export {setupCommands} from '../onboarding/setup-commands.ts';
import {setupCommands} from '../onboarding/setup-commands.ts';
export function clientSummary(client:Client):{label:string;tone:'neutral'|'success'|'warning'|'danger'} {
  if(client.history==='import'&&client.historyProgress.state==='failed')return {label:'Import needs attention',tone:'danger'};
  if(client.humanTasks.length)return {label:'Continue in your agent',tone:'warning'};
  if(client.forward&&client.proof.state==='verified'&&client.mcp.state!=='authenticated')return {label:'MCP verification pending',tone:'warning'};
  // A sandboxed agent may verify over native MCP before the CLI can publish its
  // next activation observation. Do not hide that evidence or infer installation.
  if(!client.installed&&client.forward&&client.proof.state==='verified')return {label:'Session searchable',tone:'success'};
  if(!client.installed&&client.forward&&client.proof.state==='waiting_index')return {label:'Waiting for search',tone:'neutral'};
  if(!client.installed&&client.forward&&client.proof.state==='waiting_capture')return {label:'Waiting for a new session',tone:'neutral'};
  if(!client.forward&&client.mcp.state!=='pending')return {label:'Future recording off',tone:'neutral'};
  if(!client.installed&&client.pluginState==='prepared')return {label:'Activation pending',tone:'neutral'};
  if(!client.installed&&client.pluginState==='error')return {label:'Installation needs attention',tone:'danger'};
  if(!client.installed&&client.pluginState==='pending')return {label:'Installation pending',tone:'neutral'};
  if(!client.installed&&client.history==='import')return {label:'History only',tone:'neutral'};
  if(!client.installed)return {label:client.pluginState==='not_selected'?'Not selected':'Installation not reported',tone:'neutral'};
  if(!client.forward)return {label:'Future recording off',tone:'neutral'};
  if(client.proof.state==='verified')return {label:'Verified',tone:'success'};
  if(client.proof.state==='waiting_index')return {label:'Waiting for search',tone:'neutral'};
  if(client.proof.state==='waiting_capture')return {label:'Waiting for a new session',tone:'neutral'};
  return {label:'Verification pending',tone:'neutral'};
}
export function pluginLabel(client:Client):string {
  if(client.installed)return 'Installed';
  if(client.pluginState==='prepared')return 'Files ready, activation not reported';
  if(client.pluginState==='pending')return 'Installation pending';
  if(client.pluginState==='error')return 'Installation needs attention';
  if(client.pluginState==='not_selected')return 'Not selected';
  return client.captureObservedAt||client.mcp.state!=='pending'||client.proof.state==='verified'?'Activation not reported':'Installation not reported';
}
export function mcpLabel(client:Client):string {
  if(client.mcp.state==='authenticated')return 'Connected';
  if(client.mcp.state==='observed')return client.forward?'Connection observed, client verification pending':'Connection observed, capture not selected';
  return client.installed||client.pluginState==='prepared'||client.forward||client.proof.id?'Sign-in required':'Not selected';
}
export function clientNeedsAgent(client:Client):boolean {
  return client.humanTasks.length>0||client.history==='import'&&client.historyProgress.state==='failed'||
    client.pluginState==='pending'||client.pluginState==='error'||
    Boolean(client.installed||client.pluginState==='prepared'||client.forward||client.proof.id)&&client.mcp.state==='pending'||
    client.forward&&(client.proof.state!=='verified'||client.mcp.state!=='authenticated');
}
export function historyLabel(client:Client):string {
  if(client.history==='skip')return 'Not selected';
  const progress=client.historyProgress;
  const count=progress.total===undefined?`${progress.completed.toLocaleString()} processed`:`${progress.completed.toLocaleString()} of ${progress.total.toLocaleString()} processed`;
  if(progress.state==='not_started')return 'Queued';
  if(progress.state==='running')return `Importing, ${count}`;
  if(progress.state==='failed')return `Paused after ${count}`;
  return `Import complete, ${count}`;
}
function updatedLabel(value:string) {
  const date=new Date(value);
  return Number.isFinite(date.getTime())?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date):'Time unavailable';
}
function ClientRow({client}: {client:Client}) {
  const summary=clientSummary(client);
  const hookLabel={unknown:'Not checked',pending:'Trust required',trusted:'Trusted',not_required:'Not required'}[client.hookTrust];
  const proofLabel={not_selected:'Not selected',pending:'Not verified',waiting_capture:'Waiting for a new session',waiting_index:'Captured, waiting for search',verified:'New session captured and searchable',expired:'Run verification again'}[client.proof.state];
  return <li className="oc-status-row">
    <div className="split"><h4>{clientName(client.client)}</h4><StatusBadge tone={summary.tone}>{summary.label}</StatusBadge></div>
    <p className="muted">Future recording {client.forward?'on':'off'}. History: {historyLabel(client)}.</p>
    <details className="oc-disclosure"><summary>Connection and import status</summary>
      <dl className="oc-status-facts">
        <div><dt>Plugin</dt><dd>{pluginLabel(client)}</dd></div>
        <div><dt>Hook trust</dt><dd>{!client.forward?'Not required':client.captureObservedAt?'Capture observed':hookLabel}</dd></div>
        <div><dt>MCP sign-in</dt><dd>{mcpLabel(client)}</dd></div>
        <div><dt>Verification</dt><dd>{proofLabel}</dd></div>
        <div><dt>History import</dt><dd>{historyLabel(client)}</dd></div>
      </dl>
      {client.pluginState==='prepared'&&clientNeedsAgent(client)&&<p className="muted">Open or reload {clientName(client.client)}, then continue setup in that client. Its plugin files are ready; native activation has not been reported.</p>}
      {client.history==='import'&&client.historyProgress.state==='failed'&&<Notice tone="warning">The history import stopped. Continue with your agent to resume it. {client.historyProgress.error}</Notice>}
      {client.humanTasks.length>0&&<p className="muted">Your agent will guide you through {client.humanTasks.map(task=>task.title).join(', ')}.</p>}
    </details>
  </li>;
}
/** Persistent setup status. Native agents own human trust and authentication steps. */
export function SetupPage({api,mcpUrl,setupStartCommand,setupCliCommand}: {api:Pick<ProductApi,'setupStatus'>;mcpUrl:string;setupStartCommand?:string;setupCliCommand?:string}) {
  const key=useMemo(()=>consoleResourceKey(api,'setup'),[api]);
  const resource=useConsoleResource(key,signal=>api.setupStatus(signal),{autoRefreshMilliseconds:5_000,staleMilliseconds:5_000});
  const commands=setupCommands(mcpUrl,typeof navigator!=='undefined'&&/Windows/.test(navigator.userAgent),setupStartCommand,setupCliCommand);
  const status=resource.data;
  const hasInstallations=Boolean(status?.installations.length);
  const needsAgent=Boolean(status?.installations.some(installation=>installation.clients.some(clientNeedsAgent)));
  const [copied,setCopied]=useState(false),[handoffOpen,setHandoffOpen]=useState(false);
  const handoff=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),2_000);return()=>clearTimeout(timer);},[copied]);
  useEffect(()=>{if(handoffOpen){const field=handoff.current?.querySelector('textarea');field?.focus();field?.select();}},[handoffOpen]);
  const continueWithAgent=async()=>{if(await copyText(commands.handoff))setCopied(true);else setHandoffOpen(true);};
  const launch=<Section title={hasInstallations?'Add or update an installation':'Start setup'} description="New setup is available for Claude Code, Codex, and Cursor on macOS. Choose plugins, future recording, and past sessions separately.">
        <div className="oc-form-measure stack-sm">
          <CopyField label="Install and set up" value={commands.start} multiline/>
          <details className="oc-disclosure"><summary>CLI already installed</summary><CopyField label="Setup command" value={commands.setup}/></details>
        </div>
      </Section>;
  return <Page title="Setup" description="Manage your agent connections and history imports.">
    <div className="stack">
      {!hasInstallations&&launch}
      {resource.error&&<Notice tone="danger">{resource.error}<div className="actions"><Button onClick={()=>void resource.reload()}>Try again</Button></div></Notice>}
      {resource.loading&&<LoadingState label="Loading setup status"/>}
      {status&&<>
        {status.firstWin&&<Notice tone="success" title="Your first session is searchable">{clientName(status.firstWin.client)} has captured and retrieved a new session. <LinkButton to="/sessions" variant="quiet">View sessions</LinkButton></Notice>}
        {needsAgent&&<Section title="Finish connecting your agents" description="Paste the handoff in your primary coding agent. It will help you trust hooks, sign in to MCP, and verify the selected clients.">
          <Button variant="primary" onClick={()=>void continueWithAgent()}>{copied?'Copied':'Continue with your agent'}</Button>
          <span className="sr-only" role="status">{copied?'Copied. Paste the handoff in your coding agent.':''}</span>
          <details ref={handoff} open={handoffOpen} onToggle={event=>setHandoffOpen(event.currentTarget.open)} className="oc-disclosure oc-form-measure"><summary>View or copy the handoff</summary><CopyField label="Agent handoff" value={commands.handoff} multiline/></details>
        </Section>}
        <Section title="Your installations" description="Import past sessions so your agents can find previous decisions, fixes, and context.">
          {!hasInstallations?<EmptyState title="No installations yet" description="Run setup to connect your first machine. You can explore the rest of the workspace while setup runs."/>:<div className="stack">{status.installations.map(installation=><section key={installation.installationId} className="oc-status-group" aria-label={installation.machine.label}>
            <div className="split"><h3>{installation.machine.label}</h3><p className="muted">Updated {updatedLabel(installation.updatedAt)}</p></div>
            {installation.clients.length?<ul className="oc-status-list">{installation.clients.map(client=><ClientRow key={client.client} client={client}/>)}</ul>:<p className="muted">No clients selected. Run setup on this machine to add one.</p>}
          </section>)}</div>}
        </Section>
      </>}
      {hasInstallations&&launch}
    </div>
  </Page>;
}
