import {useEffect, useRef, useState} from 'react';
import type {ConsoleExtensions} from '../application/app.tsx';
import type {Bootstrap} from '../application/api.ts';
import {useResource} from '../application/resource.ts';
import {machineKeyApi, type MachineKey} from '../application/transport.ts';
import {Button, CopyField, Dialog, Field, Input, LinkButton, LoadingState, Notice, Section, Table} from '../design/components.tsx';
import {Link} from '../router.tsx';

const settingsPath = '/settings/api-keys';
const createPath = '/setup#api-key';

function useKeyMutation() {
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => request.current?.abort(), []);

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const current = new AbortController();
    request.current = current;
    setBusy(true);
    setError('');
    try { await action(current.signal); }
    catch (failure) {
      if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not save the change.');
    } finally {
      if (!current.signal.aborted) {request.current = null; setBusy(false);}
    }
  }
  return {run, busy, error, clearError: () => setError('')};
}

function CreateApiKey() {
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const mutation = useKeyMutation();

  async function create(signal: AbortSignal) {
    const result = await machineKeyApi.create(name.trim(), signal);
    if (signal.aborted) return;
    setSecret(result.secret);
    setName('');
    window.dispatchEvent(new Event('opencrawl:console-mutated'));
  }
  function close() {
    setSecret('');
    requestAnimationFrame(() => nameInput.current?.focus());
  }
  return <div className="stack">
    <form className="field-inline oc-management-form oc-form-measure" onSubmit={event => {event.preventDefault(); if (name.trim()) void mutation.run(create);}}>
      <Field label="Key name"><Input ref={nameInput} value={name} onChange={event => setName(event.target.value)} maxLength={64} disabled={mutation.busy} required autoComplete="off" placeholder="e.g. Claude Code service"/></Field>
      <Button type="submit" variant="primary" busy={mutation.busy} disabled={!name.trim()}>Create API key</Button>
    </form>
    {mutation.error && <Notice tone="danger">{mutation.error}</Notice>}
    <p className="oc-field-hint">Use one key per service. <Link to={settingsPath}>Manage API keys</Link></p>
    {secret && <Dialog open title="Copy your API key" description="This key is shown once. Save it in your service’s secret store." onClose={close} actions={<Button variant="primary" onClick={close}>Done</Button>}>
      <CopyField label="API key" value={secret}/>
    </Dialog>}
  </div>;
}

function ApiKeySettings() {
  const [selected, setSelected] = useState<MachineKey | null>(null);
  const {data, loading, error, reload, updateData} = useResource(machineKeyApi.list);
  const mutation = useKeyMutation();
  const section = useRef<HTMLDivElement>(null);
  async function revoke(key: MachineKey, signal: AbortSignal) {
    await machineKeyApi.revoke(key.id, signal);
    if (signal.aborted) return;
    updateData(current => ({keys: (current?.keys ?? []).filter(item => item.id !== key.id)}));
    setSelected(null);
    requestAnimationFrame(() => {
      (section.current?.querySelector<HTMLButtonElement>('tbody button') ?? section.current?.querySelector<HTMLAnchorElement>('a'))?.focus();
    });
    void reload();
  }
  const createLink = <LinkButton to={createPath}>Create API key</LinkButton>;
  return <div ref={section} className="oc-management-page">
    <Section className="oc-management-panel" title="API keys" actions={createLink}>
      {loading && !data && <LoadingState label="Loading API keys"/>}
      {error && <Notice tone="danger" actions={<Button onClick={() => void reload()}>Retry</Button>}>{error}</Notice>}
      {data && (data.keys.length ? <Table label="Active API keys">
        <thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col" aria-label="Actions"/></tr></thead>
        <tbody>{data.keys.map(key =>
          <tr key={key.id}>
            <td>{key.name}</td>
            <td className="muted"><time dateTime={key.createdAt}>{new Date(key.createdAt).toLocaleDateString(undefined, {year:'numeric', month:'short', day:'numeric'})}</time></td>
            <td><Button variant="danger-quiet" aria-label={'Revoke ' + key.name} onClick={() => {mutation.clearError(); setSelected(key);}}>Revoke</Button></td>
          </tr>)}</tbody>
      </Table> : <p className="muted">No active API keys.</p>)}
    </Section>
    {selected && <Dialog open title={'Revoke ' + selected.name + '?'} description="Agents using this key will lose access immediately." onClose={() => {if (!mutation.busy) setSelected(null);}} actions={<>
      <Button disabled={mutation.busy} onClick={() => setSelected(null)}>Cancel</Button>
      <Button variant="danger" busy={mutation.busy} onClick={() => void mutation.run(signal => revoke(selected, signal))}>Revoke key</Button></>}>
      {mutation.error && <Notice tone="danger">{mutation.error}</Notice>}
    </Dialog>}
  </div>;
}

export const apiKeyExtensions: ConsoleExtensions<Bootstrap> = {
  computerApiKeys: <CreateApiKey/>,
  routes: ({data}) => data?.workspace.role === 'admin' ? [{path:settingsPath, label:'API keys', group:'settings', element:<ApiKeySettings key={data.cacheScope}/>}] : [],
};
