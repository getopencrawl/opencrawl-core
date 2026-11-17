import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Button, Dialog, EmptyState, Field, Icon, Input, LoadingState, Notice, Page, Section, Navigate} from '../index.ts';
import {ConsoleApiError, externalTarget, failureMessage} from './errors.ts';
import type {SourceCard, SourcesAdapter} from './api.ts';
import {useResource} from './resource';
import {disconnectDescription, sourceDeletable} from './source-model';
import {ConnectorSetupDialog} from './connector-setup.tsx';
import {ConnectorCard, ProviderIcon, SourceStats, SourceProgress} from './connector-card.tsx';
import {alphabeticalSources, sourceConnected} from './connector-card-model.ts';
import {listPhrase} from '../onboarding/model.ts';
import {ReplicasHistoryDialog} from './replicas-history-dialog.tsx';

// Pick up the first background snapshot promptly, then return to normal polling.
const refreshInterval = (data: {items: SourceCard[]} | undefined) => data?.items.some(source => source.statusUpdatedAt === null && source.statusRefreshing && !source.statusUnavailable) ? 1000 : 30_000;

export function SourcesPage({adapter, canConfigure = false}: {adapter: SourcesAdapter; /** Admin permission for shared integrations and operator credentials. */ canConfigure?: boolean}) {
  return canConfigure ? <AdminSourcesPage adapter={adapter}/> : <Navigate to="/" replace/>;
}
function AdminSourcesPage({adapter}:{adapter:SourcesAdapter}) {
  const canConfigure = true;
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const {data, error, loading, reload, invalidate} = useResource(adapter.sources, {autoRefreshMilliseconds:refreshInterval, paused:pending !== null});
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmation, setConfirmation] = useState<SourceCard | null>(null);
  const [keySource, setKeySource] = useState<SourceCard | null>(null);
  const [setupSource, setSetupSource] = useState<SourceCard | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [replicasSource,setReplicasSource]=useState<SourceCard|null>(null);
  const popup = useRef<Window | null>(null);
  const mutation = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; mutation.current?.abort(); mutation.current = null; popup.current?.close();};
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== popup.current || typeof event.data !== 'object' || event.data === null || !('type' in event.data)) return;
      if (event.data.type === 'opencrawl:integrations' && !mutation.current && document.visibilityState === 'visible') void reload();
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [reload]);
  useEffect(() => {
    if (!data && !loading && error) {setConfirmation(null); setKeySource(null); setSetupSource(null); setReplicasSource(null); setApiKey('');}
  }, [data, loading, error]);

  const current = (request: AbortController) => mounted.current && mutation.current === request && !request.signal.aborted;
  async function run(id: string, action: (request: AbortController) => Promise<void>) {
    if (!mounted.current || mutation.current) return;
    const request = new AbortController();
    mutation.current = request;
    setPending(id);
    setActionError('');
    setSuccess('');
    try {await action(request); if (current(request)) await reload();}
    catch (failure) {
      if (!current(request)) return;
      const message = failureMessage(failure);
      if (failure instanceof ConsoleApiError && [401,402,403].includes(failure.status)) {
        setConfirmation(null);setKeySource(null);setSetupSource(null);setApiKey('');invalidate(message);await reload();
      } else setActionError(message);
    }
    finally {if (current(request)) {mutation.current = null; setPending(null);}}
  }

  function connect(source: SourceCard, key?: string) {
    if (mutation.current) return;
    if (source.auth === 'api-key' && !key) {setActionError(''); setApiKey(''); setKeySource(source); return;}
    // Reserve the window during the user gesture, before the network request.
    if (source.auth !== 'api-key') popup.current = window.open('', 'opencrawl-connect', 'popup,width=520,height=720');
    const opened = popup.current;
    void run(source.provider, async request => {
      try {
        const result = await adapter.connect(source.provider, key, request.signal);
        if (!current(request)) return;
        if (source.auth === 'api-key') {
          setApiKey(''); setKeySource(null); setSuccess(`${source.name} connected. Your import is starting.`);
        } else {
          if (!result.redirectUrl) throw new Error('The sign-in link couldn’t load. Please try again.');
          const target = externalTarget(result.redirectUrl);
          if (opened && !opened.closed) opened.location.href = target;
          else window.location.assign(target);
        }
      } catch (failure) {opened?.close(); throw failure;}
    });
  }

  /** Store the operator credential a connector is waiting for, then continue into its sign-in. */
  function saveCredential(source: SourceCard, credentialId: string, value: string) {
    const save = adapter.saveCredential;
    if (mutation.current || !save) return;
    // Reserve the window during the user gesture, before the network requests.
    if (source.auth !== 'api-key') popup.current = window.open('', 'opencrawl-connect', 'popup,width=520,height=720');
    const opened = source.auth !== 'api-key' ? popup.current : null;
    void run(source.provider, async request => {
      try {
        await save(credentialId, value, request.signal);
        if (!current(request)) return;
        setSetupSource(null);
        await reload();
        if (!current(request)) return;
        if (source.auth === 'api-key') {setSuccess(`${source.setup?.credential?.name ?? 'Connector'} key saved. ${source.name} is ready to connect.`); return;}
        const result = await adapter.connect(source.provider, undefined, request.signal);
        if (!current(request)) return;
        if (!result.redirectUrl) throw new Error('The key was saved, but the sign-in link couldn’t load. Choose Connect to try again.');
        const target = externalTarget(result.redirectUrl);
        if (opened && !opened.closed) opened.location.href = target;
        else window.location.assign(target);
      } catch (failure) {opened?.close(); throw failure;}
    });
  }

  function submitKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (keySource && apiKey.trim()) connect(keySource, apiKey.trim());
  }

  function remove() {
    if (!confirmation) return;
    const selected = confirmation;
    void run(selected.provider, async request => {
      await adapter.disconnect(selected.provider, request.signal);
      if (!current(request)) return;
      setConfirmation(null);
      setSuccess(`${selected.name} disconnected and its imported data deleted.`);
    });
  }

  const sources = alphabeticalSources(data?.items ?? []);
  const showSearch = sources.length >= 15;
  const searchQuery = showSearch ? query.trim().toLowerCase() : '';
  const visible = sources.filter(source=>`${source.name} ${source.description ?? ''}`.toLowerCase().includes(searchQuery));
  const groups = [{title:'Available', items:visible.filter(source=>!sourceConnected(source))}, {title:'Connected', items:visible.filter(sourceConnected)}];
  const unlock = data?.items.find(source => source.state === 'setup-required' && source.setup?.credential)?.setup?.credential;
  return <Page bodyClassName="oc-connections" id="data-controls" title="Integrations" description="Connect your tools and OpenCrawl keeps their content in sync for your agents.">
    {error && <Notice tone="danger">{data ? 'Connection status couldn’t update. We’ll try again automatically while you’re viewing this page.' : error}</Notice>}
    {actionError && !confirmation && !keySource && !setupSource && <Notice tone="danger">{actionError}</Notice>}
    {unlock && canConfigure && adapter.saveCredential && <Notice>{`One ${unlock.name} key unlocks ${listPhrase(unlock.unlocks)}. Choose Connect on any of them to add it.`}</Notice>}

    {success && <Notice tone="success">{success}</Notice>}
    {!data ? loading ? <LoadingState label="Loading integrations" /> : <EmptyState title="Integrations couldn’t load" description="Try again to see your connections." action={<Button onClick={() => void reload()}>Try again</Button>} /> : <>
      {showSearch && <div className="oc-source-toolbar"><div className="oc-source-search"><Icon name="search" size={16}/><Input type="search" aria-label="Search integrations" placeholder="Search integrations" value={query} onChange={event=>setQuery(event.target.value)}/></div></div>}
      {groups.filter(group=>group.items.length>0).map(group=><Section key={group.title} title={group.title} className="oc-source-section">
        <div className={group.title === 'Available' ? 'oc-source-grid' : 'oc-integration-grid'}>
          {group.items.map(source => source.provider==='replicas'&&adapter.replicasHistory?<ConnectorCard key={source.provider} source={source} action={source.history?'View import':'Import history'} pending={pending!==null} busy={false} onAction={()=>setReplicasSource(source)}/>:<SourceRow key={source.provider} source={source} canManage={canConfigure || source.scope === 'user'} pending={pending !== null} active={pending === source.provider} connect={() => connect(source)} setUp={() => {setActionError(''); setSetupSource(source);}} retry={() => void run(source.provider, async request => {await adapter.retry(source.provider, request.signal); if (current(request)) setSuccess(source.recoveryAction === 'disconnect' ? `${source.name} removal completed and its imported data deleted.` : `${source.name} sync requested.`);})} disconnect={() => {setActionError(''); setConfirmation(source);}} />)}
        </div>
      </Section>)}
      {sources.length > 0 && !visible.length && <EmptyState title="No matching integrations" description="Try another name or clear your search." action={<Button onClick={()=>setQuery('')}>Clear search</Button>}/>}
      {!data.items.length && <EmptyState title="No integrations available" description="Available connections will appear here." />}
    </>}
    {replicasSource&&<ReplicasHistoryDialog adapter={adapter} initial={replicasSource.history} onClose={()=>setReplicasSource(null)} onChange={()=>void reload()}/>}
    <Dialog open={confirmation !== null} onClose={() => {if (!pending) setConfirmation(null);}} title={`Disconnect ${confirmation?.name ?? 'source'}?`} description={confirmation ? disconnectDescription(confirmation) : undefined} actions={<><Button disabled={pending !== null} onClick={() => setConfirmation(null)}>Cancel</Button><Button variant="danger" disabled={pending !== null} onClick={remove}>{pending ? 'Disconnecting…' : 'Disconnect and delete'}</Button></>}>
      {actionError && <Notice tone="danger">{actionError}</Notice>}
    </Dialog>
    <ConnectorSetupDialog source={setupSource} canConfigure={canConfigure} busy={pending !== null} error={actionError} onSave={adapter.saveCredential ? (id, value) => {if (setupSource) saveCredential(setupSource, id, value);} : undefined} onClose={() => {if (!pending) setSetupSource(null);}} />
    <Dialog open={keySource !== null} onClose={() => {if (!pending) {setApiKey(''); setKeySource(null);}}} title={keySource?.keyHelp?.title ?? `Connect ${keySource?.name ?? 'source'}`} description={keySource?.keyHelp?.body}>
      <form className="stack" onSubmit={submitKey}>
        <Field label={keySource?.keyHelp?.label ?? 'Workspace API key'} hint="The key is sent securely to set up this connection. It is never stored in this browser."><Input type="password" autoComplete="off" spellCheck={false} required value={apiKey} placeholder={keySource?.keyHelp?.placeholder} onChange={event => setApiKey(event.target.value)} /></Field>
        {actionError && <Notice tone="danger">{actionError}</Notice>}
        <div className="actions"><Button disabled={pending !== null} onClick={() => {setApiKey(''); setKeySource(null);}}>Cancel</Button><Button type="submit" variant="primary" disabled={pending !== null || !apiKey.trim()}>{pending ? 'Checking key…' : `Connect ${keySource?.name ?? 'source'}`}</Button></div>
      </form>
    </Dialog>
  </Page>;
}

/** Available connectors start setup directly; connected cards retain management. */
export function SourceRow({source, canManage = false, pending, active, connect, retry, disconnect, setUp}: {source: SourceCard; canManage?: boolean; pending: boolean; active: boolean; connect: () => void; retry: () => void; disconnect: () => void; setUp?: () => void}) {
  const [open, setOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const available = source.state === 'disconnected' || source.state === 'setup-required';
  const action = available ? canManage ? 'Connect' : 'Details' : !canManage || source.state === 'unavailable' ? 'Details' : source.state === 'error' ? 'Fix connection' : 'Manage';
  const restart = source.state === 'connecting' || source.recoveryAction === 'connect';
  const retryable = source.state === 'error' && !source.reconnect && !restart;
  function invoke(callback: () => void) {setOpen(false); callback();}
  function show() {
    if (source.state === 'setup-required' && source.setup) {(setUp ?? (()=>setSetupOpen(true)))();return;}
    if (source.state === 'disconnected' && canManage) {connect();return;}
    setOpen(true);
  }
  return <>
    <ConnectorCard source={source} action={action} pending={pending} busy={active} onAction={show}/>
    <Dialog open={open} onClose={()=>{if(!pending)setOpen(false);}} title={`${action} ${source.name}`} description={source.help ?? source.description} actions={canManage ? <>
      {sourceDeletable(source) && <Button variant="danger" aria-label={`Disconnect ${source.name}`} disabled={pending} onClick={()=>invoke(disconnect)}>Disconnect</Button>}
      {['connected','synced'].includes(source.state) && <Button disabled={pending} onClick={()=>invoke(retry)}>Sync now</Button>}
      {restart && <Button variant="primary" disabled={pending} onClick={()=>invoke(connect)}>{active ? 'Connecting…' : 'Restart sign-in'}</Button>}
      {retryable && <Button disabled={pending} onClick={()=>invoke(retry)}>{active ? 'Retrying…' : source.recoveryAction === 'disconnect' ? 'Retry removal' : 'Retry sync'}</Button>}
    </> : undefined}>
      <div className="oc-source-detail-account"><ProviderIcon source={source}/><div><strong>{source.account || (source.scope === 'user' ? 'Personal connection' : 'Workspace connection')}</strong>{source.connectedBy && <p>Connected by {source.connectedBy}</p>}</div></div>
      {!available && <SourceProgress source={source}/>}
      {Boolean(source.rows?.length) && <SourceStats source={source}/>}
    </Dialog>
    {source.setup && !setUp && <Dialog open={setupOpen} onClose={()=>setSetupOpen(false)} title={source.setup.title}><p>{source.setup.body}</p></Dialog>}
  </>;
}
