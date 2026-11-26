import {useEffect, useRef, useState} from 'react';
import {Button, CopyField, Dialog, Field, Input, LoadingState, Notice, Section, Table} from '../design/components.tsx';
import {useResource} from '../application/resource.ts';
import {machineKeyApi, type MachineKey} from '../application/transport.ts';

export function MachineKeysPage() {
  const {data, loading, error, reload, updateData} = useResource(machineKeyApi.list);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [revoking, setRevoking] = useState<MachineKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => {active.current?.abort();}, []);

  async function mutate(action: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setFailure('');
    try { await action(request.signal); }
    catch (e) {if (!request.signal.aborted) setFailure(e instanceof Error ? e.message : 'Could not save the change.');}
    finally {if (!request.signal.aborted) {active.current = null; setBusy(false); void reload();}}
  }

  function create(signal: AbortSignal) {
    return machineKeyApi.create(name.trim(), signal).then(result => {
      if (signal.aborted) return;
      setSecret(result.secret);
      setName('');
      updateData(current => ({keys: [...current?.keys ?? [], result.key]}));
    });
  }
  function revoke(key: MachineKey, signal: AbortSignal) {
    return machineKeyApi.revoke(key.id, signal).then(() => {
      if (signal.aborted) return;
      updateData(current => ({keys: (current?.keys ?? []).filter(item => item.id !== key.id)}));
      setRevoking(null);
    });
  }
  return <div className="oc-management-page">
    <Section title="Machine keys" description="Give an unattended agent access to this workspace.">
      <form className="stack" onSubmit={event => {event.preventDefault(); void mutate(create);}}>
        <Field label="Key name"><Input value={name} onChange={e => setName(e.target.value)} maxLength={64} required autoComplete="off" placeholder="Support agent"/></Field>
        <div className="actions"><Button type="submit" variant="primary" disabled={!data || !name.trim()} busy={busy && !revoking}>Create key</Button></div>
      </form>
      {failure && !revoking && <Notice tone="danger">{failure}</Notice>}
    </Section>
    <Section title="Active keys">
      {loading && !data && <LoadingState label="Loading machine keys" spinner/>}
      {error && <Notice tone="danger" actions={<Button onClick={() => void reload()}>Retry</Button>}>{error}</Notice>}
      {data && (data.keys.length ? <Table label="Active machine keys"><thead><tr><th>Name</th><th>Created</th><th aria-label="Actions"/></tr></thead><tbody>
        {data.keys.map(key => <tr key={key.id}><td>{key.name}</td><td>{new Date(key.createdAt).toLocaleDateString()}</td><td><Button variant="danger-quiet" disabled={busy} onClick={() => {setFailure(''); setRevoking(key);}} aria-label={'Revoke ' + key.name}>Revoke</Button></td></tr>)}
      </tbody></Table> : <p>No active keys.</p>)}
    </Section>
    {secret && <Dialog open title="Copy your machine key" description="Save this key in your agent’s secret store before closing this dialog." onClose={() => setSecret('')} actions={<Button onClick={() => setSecret('')}>Done</Button>}>
      <CopyField label="Machine key" value={secret}/>
    </Dialog>}
    {revoking && <Dialog open title={'Revoke ' + revoking.name + '?'} description="Agents using this key will lose access immediately." onClose={() => {if (!busy) setRevoking(null);}} actions={<>
      <Button disabled={busy} onClick={() => setRevoking(null)}>Cancel</Button>
      <Button variant="danger" busy={busy} onClick={() => void mutate(signal => revoke(revoking, signal))}>Revoke key</Button></>}>
      {failure && <Notice tone="danger">{failure}</Notice>}
    </Dialog>}
  </div>;
}
