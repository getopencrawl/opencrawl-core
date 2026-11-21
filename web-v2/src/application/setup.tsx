import {useEffect, useState} from 'react';
import {Button, Dialog, Icon, Notice, Page, Section, Tabs} from '../design/components.tsx';
import {nativeInstallCommand} from '../../../src/sessions/cli-installation.mjs';
import {CommandSnippet} from '../onboarding/copy.tsx';
import {connectionCommands} from '../onboarding/model.ts';
import {ReplicasCaptureSetup} from '../onboarding/replicas-capture.tsx';
import type {OnboardingAdapter} from '../onboarding/types.ts';
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
  return <div className="oc-form-measure oc-install-instructions">
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
    {agents.length > 0 ? <>
      <LastSeen at={installation.updatedAt} now={now}/>
      <dl className="oc-computer-agents" aria-label="Connected agents and their last contact">
        {agents.map(agent => <LastSeen key={agent.client} agent={clientNames[agent.client]} at={agent.lastSeenAt} now={now}/>)}
      </dl>
    </> : <p className="oc-computer-empty">No connected agents</p>}
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

/** Setup is a progress page. Choices and continuation live in the CLI. */
export function SetupPage({status, error, replicasSetup, mcpUrl}: {mcpUrl: string; status: NonNullable<Bootstrap['setup']>; error: string; replicasSetup?: OnboardingAdapter['replicasSetup']}) {
  const [connecting, setConnecting] = useState(false);
  const installations = status?.installations ?? [];
  return <Page className="oc-management-page" title="Setup" description="Connect your coding agents to this workspace.">
    {error && <Notice tone="danger">{error} Your saved choices are unchanged.</Notice>}
    {installations.length > 0
      ? <Section className="oc-source-section oc-computers-section" title="Your computers"
          actions={<Button variant="primary" onClick={() => setConnecting(true)}><Icon name="plus" size={16}/>Connect an agent</Button>}>
          <ComputerGrid installations={installations}/>
        </Section>
      : <Section className="oc-management-panel" title="Connect your first agent" description="Install OpenCrawl on the computer where your agent runs.">
          <AgentInstructions mcpUrl={mcpUrl}/>
        </Section>}
    {replicasSetup && <ReplicasCaptureSetup issue={replicasSetup}/>}
    {(installations.length > 0 || connecting) && <Dialog open={connecting} onClose={() => setConnecting(false)} title="Connect an agent" description="Install OpenCrawl on the computer where your agent runs."><AgentInstructions mcpUrl={mcpUrl}/></Dialog>}
  </Page>;
}
