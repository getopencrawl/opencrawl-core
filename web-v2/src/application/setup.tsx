import {useEffect, useState} from 'react';
import {Icon, LinkButton, Notice, Page, Section, Table, Tabs} from '../design/components.tsx';
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

const verificationMessage = 'verify opencrawl installation';

const setupSteps = [
  {title:'Authenticate the CLI', detail:'Run the command above and confirm the sign-in code in your browser.'},
  {title:'Connect your agents', detail:'Select one or more agents in the CLI.'},
  {title:'Run an example session to verify capture', detail:`Send “${verificationMessage}” to each connected agent. Look for “Captured and searchable” below.`},
];

function AgentInstructions({mcpUrl, first}: {mcpUrl: string; first: boolean}) {
  const [platform, setPlatform] = useState(() => /Windows/.test(navigator.userAgent) ? 'windows' : 'unix');
  const workspace = new URL(mcpUrl).origin;
  const windows = connectionCommands(mcpUrl, true);
  const apiArg = workspace === 'https://app.getopencrawl.com' ? '' : ` --api '${workspace.replaceAll("'", "'\\''")}'`;
  const text = platform === 'windows'
    ? `${windows.cli}\n${windows.recording}`
    : `${nativeInstallCommand()} -s -- --connect${apiArg}`;
  return <Section className="oc-host-install" title={first ? 'Connect your first host' : 'Connect another host'}
    description={platform === 'windows'
      ? 'On the computer you want to connect, paste these commands into PowerShell. Sign in and choose which agents to record.'
      : 'On the computer you want to connect, paste this command into Terminal. Sign in and choose which agents to record.'}>
    <div className="oc-install-instructions">
      <Tabs label="Operating system" items={platforms} value={platform} onChange={setPlatform}/>
      <CommandSnippet key={platform} label="Copy setup command" text={text}/>
    </div>
    {first && <ol className="oc-host-guide" aria-label="Setup steps">
      {setupSteps.map(step => <li key={step.title}>
        <h3>{step.title}</h3>
        <p>{step.detail}</p>
      </li>)}
    </ol>}
  </Section>;
}

const recentContactWindow = 15 * 60_000;

function LastSeen({at, now, agent}: {at?: string; now: number; agent?: string}) {
  const seen = Date.parse(at ?? '');
  const valid = Number.isFinite(seen);
  const age = now - seen;
  const exact = valid ? new Date(seen).toLocaleString() : '';
  return <span className={(agent ? 'oc-host-last-contact' : 'oc-computer-contact') + ' oc-presence'}
    data-recent={valid ? age >= -60_000 && age < recentContactWindow : undefined}>
    {at && valid ? <>{agent ? 'Last contact ' : 'Seen '}<time dateTime={at} title={(agent ? 'Last contact from ' + agent + ' at ' : 'Last setup report or live capture received ') + exact}>{age < -60_000 ? exact : ago(at,now)}</time></> : agent ? 'No signal yet' : 'Last check-in unknown'}
  </span>;
}

type Agent = Installation['clients'][number];

function captureStatus(agent: Agent) {
  if (!agent.forward) return {label:'Recording off'};
  if (agent.proof.state === 'verified') return {label:'Captured and searchable'};
  if (agent.proof.state === 'expired') return {label:'Verification expired', hint:'Run verification again in this agent.'};
  if (agent.proof.state === 'waiting_index' || agent.captureObservedAt) return {label:'Captured, awaiting search'};
  if (agent.hookTrust === 'pending' || agent.humanTasks.some(task => task.kind === 'hook_trust')) return {label:'Approval needed', hint:'Approve the OpenCrawl hooks in the agent’s trust settings.'};
  return {label:'Waiting for a new session', hint:`In ${clientNames[agent.client]}, send “${verificationMessage}”.`};
}

function ComputerTile({installation, now}: {installation: Installation; now: number}) {
  const agents = installation.clients.filter(client => client.installed || client.forward || client.pluginState === 'error' || client.pluginState === 'prepared' || client.pluginState === 'pending');
  return <li className="oc-host-report">
    <header className="oc-host-title"><div><Icon name="monitor" size={19}/><h3>{installation.machine.label}</h3></div><LastSeen at={installation.updatedAt} now={now}/></header>
    {agents.length > 0 ? <Table className="oc-host-agents" label={`Agent verification on ${installation.machine.label}`}>
      <thead><tr><th scope="col">Agent</th><th scope="col">Workspace connection</th><th scope="col">Session capture</th></tr></thead>
      <tbody>{agents.map(agent => {
        const connected = agent.mcp.state === 'authenticated' || (!agent.forward && agent.mcp.state === 'observed');
        const name = clientNames[agent.client];
        const connection = connected ? 'Connected' : agent.pluginState === 'error' ? 'Retry plugin setup' : 'Awaiting sign-in';
        const capture = captureStatus(agent);
        return <tr key={agent.client}><th scope="row">{name}<LastSeen agent={name} at={agent.lastSeenAt} now={now}/></th>
          <td><span className="oc-host-status" data-confirmed={connected}><Icon name={connected ? 'check' : 'clock'} size={15}/>{connection}</span></td>
          <td><span className="oc-host-status" data-confirmed={agent.forward && agent.proof.state === 'verified'}>{capture.label}</span>
            {capture.hint && <small>{capture.hint}</small>}
          </td></tr>;
      })}</tbody>
    </Table> : <p className="oc-host-no-agents">No connected agents yet. Select one or more agents in the CLI.</p>}
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
  return <ul className="oc-host-roster" aria-label="Computers">
    {installations.map(installation => <ComputerTile key={installation.installationId} installation={installation} now={now}/>)}
  </ul>;
}

export function SetupPage({status, error, mcpUrl}: {mcpUrl: string; status: NonNullable<Bootstrap['setup']>; error: string}) {
  const {installations} = status;
  const first = installations.length === 0;
  const searchable = installations.some(host => host.clients.some(agent => agent.forward && agent.proof.state === 'verified'));
  return <Page className="oc-management-page" bodyClassName="oc-host-setup" title="Setup">
    {error && <Notice tone="danger">{error}</Notice>}
    <div className="oc-host-start">
      <header className="oc-host-welcome" data-first={first}>
        <div><h2>{first ? 'Welcome to OpenCrawl' : searchable ? 'Your first session is searchable' : installations.length === 1 ? 'Your host has checked in' : 'Your hosts have checked in'}</h2>
          <p>{first ? 'OpenCrawl lets your agents talk to each other and read each other’s session histories. Run the setup command below on the computer where you use your agents.'
            : searchable ? 'Open Sessions to revisit captured work. You can see which agents have finished setup below.'
            : 'Continue in the agents you selected. This page will show when each one connects and records a searchable session.'}</p></div>
        {first && <img src="/assets/setup-first-host.png" alt="" width="136" height="64"/>}
      </header>
      <AgentInstructions mcpUrl={mcpUrl} first={first}/>
    </div>
    <Section className="oc-hosts-section" title="Your hosts"
      description={first ? undefined : 'Check the connection and recording status for each agent you selected.'}
      actions={searchable ? <LinkButton to="/sessions" variant="secondary">View sessions<Icon name="arrow-right" size={15}/></LinkButton> : undefined}>
      {first ? <div className="oc-host-wait"><Icon name="monitor" size={20}/><div><strong>Waiting for your first host</strong><p>This list updates automatically when your computer checks in.</p></div></div>
        : <ComputerGrid installations={installations}/>}
    </Section>
  </Page>;
}
