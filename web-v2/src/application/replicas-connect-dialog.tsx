import {useEffect, useId, useRef, useState, type FormEvent} from 'react';
import {Button, Dialog, ExternalLink, Field, Input, Notice} from '../design/components.tsx';
import {ReplicasAgentSetup} from '../onboarding/replicas-agent-setup.tsx';
import type {ReplicasImportStatus} from '../../../src/integrations/replicas-import.mjs';
import type {SourcesAdapter} from './api.ts';
import {failureMessage} from './errors.ts';

export function ReplicasConnectDialog({history, issue, onClose, onConnected}: {
  history?: SourcesAdapter['replicasHistory'];
  issue?: SourcesAdapter['replicasSetup'];
  onClose: () => void;
  onConnected: (result: ReplicasImportStatus) => void;
}) {
  const formId = useId();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (active.current || !history || !key.trim()) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setError('');
    try {
      const result = await history({action:'connect', apiKey:key.trim()}, request.signal);
      if (!request.signal.aborted) onConnected(result);
    } catch (failure) {
      if (!request.signal.aborted) setError(failureMessage(failure));
    } finally {
      active.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }
  return <Dialog open onClose={onClose} title={history ? 'Connect Replicas' : 'Set up Replicas agents'} actions={history && <>
    <Button onClick={onClose}>Cancel</Button>
    <Button type="submit" form={formId} variant="primary" disabled={busy || !key.trim()}>{busy ? 'Connecting…' : 'Connect'}</Button>
  </>}>
    <div className="stack">
      {history && <form id={formId} className="stack-sm" onSubmit={connect}>
        <p>To capture your organization’s Replicas chats, enter a key from <ExternalLink href="https://app.replicas.dev/dashboard/settings?tab=api-keys">Replicas API Keys</ExternalLink>.</p>
        <Field label="Organization API key"><Input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} required/></Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>}
      {issue && <ReplicasAgentSetup issue={issue}/>}
    </div>
  </Dialog>;
}
