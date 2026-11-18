import {useState} from 'react';
import {Button, CopyField, Dialog, Icon, Notice, Page, Section, StatusBadge} from '../design/components.tsx';
import {nativeInstallCommand} from '../../../src/sessions/cli-installation.mjs';
import type {Bootstrap} from './api.ts';

const clientNames = {'claude-code':'Claude Code', codex:'Codex', cursor:'Cursor', antigravity:'Antigravity', 'grok-bot':'Grok Bot', devin:'Devin', 'claude-desktop':'Claude Desktop', chatgpt:'ChatGPT'};

type Installation = NonNullable<Bootstrap['setup']>['installations'][number];
type Client = Installation['clients'][number];

const historyLabels = {
  not_started: 'Waiting to import past sessions',
  running: 'Importing past sessions in the background',
  complete: 'Past sessions imported',
  failed: 'Past session import needs attention in the CLI',
};
const installCommand = nativeInstallCommand() + ' -s -- --setup';

function MachineInstructions() {
  return <div className="oc-form-measure stack-sm">
    <CopyField label="Run in Terminal on the Mac you want to connect" value={installCommand} multiline/>
    <p className="muted">Already installed? Run <code>opencrawl setup</code> on that machine to resume setup or review your choices.</p>
  </div>;
}

function connectionSelected(client: Client) {
  return client.forward || client.installed || Boolean(client.pluginState && client.pluginState !== 'not_selected');
}

function connectionProgress(client: Client) {
  const connected = client.mcp.state === 'authenticated' || (!client.forward && client.mcp.state === 'observed');
  const searchable = client.proof.state === 'verified';
  return {connected, searchable, ready: client.installed && connected && (!client.forward || searchable)};
}

function clientSummary(client: Client) {
  const checks = [];
  if (connectionSelected(client)) {
    const {connected, searchable} = connectionProgress(client);
    if (client.pluginState === 'error') checks.push('Plugin needs attention in the CLI');
    else if (!client.installed) checks.push('Waiting for plugin installation');
    if (connected) checks.push('Workspace connection verified');
    else if (client.installed) checks.push('Waiting for workspace connection');
    if (!client.forward) checks.push('Recording off');
    else if (searchable) checks.push('Captured and searchable');
    else if (connected && client.installed) checks.push('Waiting for a searchable session');
  }
  if (client.history === 'import') checks.push(historyLabels[client.historyProgress.state]);
  return checks.join('. ') + '.';
}

function MachineRow({installation}: {installation: Installation}) {
  const clients = installation.clients.filter(client => connectionSelected(client) || client.history === 'import');
  const connections = clients.filter(connectionSelected);
  const ready = connections.filter(client => connectionProgress(client).ready).length;
  const failed = clients.some(client => client.pluginState === 'error' || (client.history === 'import' && client.historyProgress.state === 'failed'));
  const summary = failed ? 'Needs attention' : connections.length ? `${ready} of ${connections.length} ready` : clients.length ? 'History only' : 'No agents selected';
  const tone = failed ? 'warning' : ready > 0 && ready === connections.length ? 'success' : 'neutral';

  return <details className="oc-machine-row">
    <summary>
      <Icon name="monitor" size={20}/>
      <span className="oc-machine-identity"><strong>{installation.machine.label}</strong>
        {clients.length > 0 && <small>{clients.map(client => clientNames[client.client]).join(', ')}</small>}
      </span>
      <StatusBadge tone={tone}>{summary}</StatusBadge>
      <Icon name="chevron-right" size={16}/>
    </summary>
    <div className="oc-machine-details">
      {clients.length > 0 && <ul aria-label={`Agent setup on ${installation.machine.label}`}>
        {clients.map(client => <li key={client.client}><strong>{clientNames[client.client]}</strong><span>{clientSummary(client)}</span></li>)}
      </ul>}
      <p className="muted">Run <code>opencrawl setup</code> on this machine to review its settings or continue setup.</p>
    </div>
  </details>;
}

/** Setup is a progress page. Choices and continuation live in the CLI. */
export function SetupPage({status, error}: {status: NonNullable<Bootstrap['setup']>; error: string}) {
  const [adding, setAdding] = useState(false);
  const installations = status?.installations ?? [];
  return <Page title="Setup" description="Connect a new machine or check setup on an existing one."
    actions={installations.length > 0 && <Button variant="primary" onClick={() => setAdding(true)}><Icon name="plus" size={16}/>Add machine</Button>}>
    <div className="stack">
      {error && <Notice tone="danger">{error} Your saved choices are unchanged.</Notice>}
      {installations.length > 0
        ? <Section className="oc-source-section" title="Your machines">
            <div className="oc-machine-list">{installations.map(installation => <MachineRow key={installation.installationId} installation={installation}/>)}</div>
          </Section>
        : <Section className="oc-source-section" title="Add your first machine" description="Install OpenCrawl and choose which agents to connect. Your machine will appear here as setup runs."><MachineInstructions/></Section>}
    </div>
    {(installations.length > 0 || adding) && <Dialog open={adding} onClose={() => setAdding(false)} title="Add a machine" description="Install OpenCrawl and choose which agents to connect."><MachineInstructions/></Dialog>}
  </Page>;
}
