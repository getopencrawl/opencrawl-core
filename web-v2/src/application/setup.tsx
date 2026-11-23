import {useEffect, useState} from 'react';
import {Icon, Notice, Page, Section, Tabs} from '../design/components.tsx';
import {nativeInstallCommand} from '../../../src/sessions/cli-installation.mjs';
import {CommandSnippet} from '../onboarding/copy.tsx';
import {connectionCommands} from '../onboarding/model.ts';
import {ago} from '../pages/usage-model.ts';
import type {Bootstrap} from './api.ts';

const clientNames = {'claude-code':'Claude Code', codex:'Codex', cursor:'Cursor', antigravity:'Antigravity', 'grok-bot':'Grok Bot', devin:'Devin', 'claude-desktop':'Claude Desktop', chatgpt:'ChatGPT'};

type Installation = NonNullable<Bootstrap['setup']>['installations'][number];

const platforms = [
  {value: 'unix', label: 'macOS / Linux'},
  {value: 'windows', label: 'Windows'},
];

function AgentInstructions({mcpUrl}: {mcpUrl: string}) {
  const [platform, setPlatform] = useState('unix');
  const workspace = new URL(mcpUrl).origin;
  const windows = connectionCommands(mcpUrl, true);
  const apiArg = workspace === 'https://app.getopencrawl.com' ? '' : ` --api '${workspace.replaceAll("'", "'\\''")}'`;
  const text = platform === 'windows'
    ? `${windows.cli}\n${windows.recording}`
    : `${nativeInstallCommand()} -s -- --connect${apiArg}`;
  return <div className="oc-install-instructions">
    <Tabs label="Operating system" items={platforms} value={platform} onChange={setPlatform}/>
    <CommandSnippet key={platform} label="Copy setup command" text={text}/>
  </div>;
}

const recentContactWindow = 15 * 60_000;

function LastSeen({at, now, agent}: {at?: string; now: number; agent?: string}) {
  const seen = Date.parse(at ?? '');
  const age = now - seen;
  const exact = Number.isFinite(seen) ? new Date(seen).toLocaleString() : undefined;
  const recent = exact ? age >= -60_000 && age < recentContactWindow : undefined;
  const source = agent ? `Last live capture from ${agent} received` : 'Last setup report or live capture received';
  const time = at && exact
    ? <time dateTime={at} title={`${source} ${exact}`}>{agent ? '' : 'Seen '}{age < -60_000 ? exact : ago(at, now)}</time>
    : (agent ? 'No signal yet' : 'Last seen unknown');

  if (agent) return <div className="oc-agent-contact">
    <dt className="oc-presence" data-recent={recent}>{agent}</dt><dd>{time}</dd>
  </div>;
  return <div className="oc-computer-contact oc-presence" data-recent={recent}>{time}</div>;
}

function ComputerTile({installation, now}: {installation: Installation; now: number}) {
  const agents = installation.clients.filter(client =>
    client.installed && (client.mcp.state === 'authenticated' || (!client.forward && client.mcp.state === 'observed')));

  return <li className="oc-computer-tile">
    <h3>{installation.machine.label}<Icon name="monitor" size={16}/></h3>
    <LastSeen at={installation.updatedAt} now={now}/>
    {agents.length > 0 ?
      <dl className="oc-computer-agents" aria-label="Connected agents and their last contact">
        {agents.map(agent => <LastSeen key={agent.client} agent={clientNames[agent.client]} at={agent.lastSeenAt} now={now}/>)}
      </dl>
    : <p className="oc-computer-empty">No connected agents</p>}
  </li>;
}

function ComputerGrid({installations}: {installations: Installation[]}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return <ul className="oc-computer-grid" aria-label="Computers">
    {installations.map(installation => <ComputerTile key={installation.installationId} installation={installation} now={now}/>)}
  </ul>;
}

export function SetupPage({status, error, mcpUrl}: {mcpUrl: string; status: NonNullable<Bootstrap['setup']>; error: string}) {
  const {installations} = status;
  return <Page className="oc-management-page" title="Setup">
    {error && <Notice tone="danger">{error}</Notice>}
    <Section className="oc-management-panel" title="Connect a host" description="On the host, run this in a terminal. Sign in and choose which agents to connect.">
      <AgentInstructions mcpUrl={mcpUrl}/>
    </Section>
    <Section className="oc-source-section oc-computers-section" title="Your hosts">
      {installations.length > 0
        ? <ComputerGrid installations={installations}/>
        : <p className="muted">No hosts connected yet. Your first host will appear here when it reports to OpenCrawl.</p>}
    </Section>
  </Page>;
}
