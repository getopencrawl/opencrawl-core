import {consoleResourceKey} from '../data.tsx';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Button, Dialog, Field, Input} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {ConnectorSetupDialog} from '../application/connector-setup.tsx';
import {isSourceConnected, listPhrase, oauthDestination} from './model.ts';
import {useOnboardingResource} from './resource.ts';
import {OnboardingShell} from './shell.tsx';
import type {OnboardingAdapter, OnboardingSource} from './types.ts';

export interface SourcesOnboardingProps {
  adapter: OnboardingAdapter;
  initialSources?: OnboardingSource[];
  /** Full navigation is reserved for an external authorization handshake. */
  authorize?: (httpsUrl: string) => void;
  /** Show admins the credential form a source's setup asks for. The server still requires an admin. */
  canConfigure?: boolean;
}

export function SourcesOnboarding({adapter, initialSources, authorize = url => window.location.assign(url), canConfigure = false}: SourcesOnboardingProps) {
  const resource = useOnboardingResource(signal => adapter.sources(signal), {key:consoleResourceKey(adapter,'onboarding-sources'), initial: initialSources ? {items: initialSources} : undefined});
  const items = resource.data?.items ?? [];
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [secretSource, setSecretSource] = useState<OnboardingSource | null>(null);
  const [setupSource, setSetupSource] = useState<OnboardingSource | null>(null);
  const [saving, setSaving] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [secret, setSecret] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const queryField = useRef<HTMLInputElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; controllers.current.forEach(controller => controller.abort()); controllers.current.clear();};
  }, []);
  useEffect(() => {if (secretSource) secretField.current?.focus();}, [secretSource]);
  const showSearch = items.length >= 15;
  const filter = showSearch ? query.trim().toLocaleLowerCase() : '';
  const matches = items.filter(item => item.name.toLocaleLowerCase().includes(filter));
  const connected = items.some(isSourceConnected);
  function closeSecret() {setSecretSource(null); setSecret('');}
  async function connect(item: OnboardingSource, apiKey?: string) {
    if (isSourceConnected(item) || controllers.current.has(item.id)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    controllers.current.set(item.id, controller);
    setPending(previous => new Set(previous).add(item.id));
    setErrors(previous => {const next = new Map(previous); next.delete(item.id); return next;});
    setAnnouncement(`Connecting ${item.name}`);
    try {
      const result = await adapter.connectSource(item.id, apiKey ? {apiKey} : {}, controller.signal);
      if (!mounted.current) return;
      if (result.redirectUrl) {authorize(oauthDestination(result.redirectUrl)); return;}
      const refreshed = await adapter.sources(controller.signal);
      if (!mounted.current) return;
      resource.replace(refreshed);
      setAnnouncement(refreshed.items.some(source => source.id === item.id && isSourceConnected(source)) ? `${item.name} connected. Next is available.` : `${item.name} connection is still being checked.`);
    } catch (failure) {
      if (!mounted.current) return;
      const message = failure instanceof Error ? failure.message : 'We couldn’t connect this source. Try again.';
      setErrors(previous => new Map(previous).set(item.id, message));
      setAnnouncement(message);
    } finally {
      clearTimeout(timeout);
      controllers.current.delete(item.id);
      if (mounted.current) setPending(previous => {const next = new Set(previous); next.delete(item.id); return next;});
    }
  }
  /** Store the operator credential, then carry on into the sign-in the admin originally asked for. */
  async function saveCredential(credentialId: string, value: string) {
    const item = setupSource;
    if (!item || !adapter.saveCredential || controllers.current.has('credential')) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    controllers.current.set('credential', controller);
    setSaving(true); setSetupError('');
    try {
      await adapter.saveCredential(credentialId, value, controller.signal);
      const refreshed = await adapter.sources(controller.signal);
      if (!mounted.current) return;
      resource.replace(refreshed); setSetupSource(null);
      setAnnouncement(`${item.setup?.credential?.name ?? 'Connector'} key saved.`);
      const unlocked = refreshed.items.find(source => source.id === item.id);
      if (unlocked && !unlocked.setup) choose(unlocked);
    } catch (failure) {
      if (mounted.current) setSetupError(failure instanceof Error ? failure.message : 'We couldn’t save that key. Try again.');
    } finally {
      clearTimeout(timeout);
      controllers.current.delete('credential');
      if (mounted.current) setSaving(false);
    }
  }
  function choose(item: OnboardingSource) {
    if(item.setup){setSetupError('');setSetupSource(item);return;}
    if (isSourceConnected(item) || pending.has(item.id)) return;
    if (item.auth === 'api-key') {setSecretSource(item); setSecret('');}
    else void connect(item);
  }
  function submitSecret(event: FormEvent) {
    event.preventDefault();
    if (!secretSource || !secret.trim()) return;
    const item = secretSource;
    const key = secret.trim();
    closeSecret();
    void connect(item, key);
  }
  const tile = (item: OnboardingSource) => {
    const done = isSourceConnected(item);
    const busy = pending.has(item.id);
    const error = errors.get(item.id);
    return <li className="connector-cell" key={item.id}><Button variant="plain" className="connector-tile" aria-disabled={done || busy} aria-busy={busy || undefined} aria-label={`${item.setup?'Set up':done ? 'Connected to' : busy ? 'Connecting to' : 'Connect'} ${item.name}`} aria-describedby={error ? `connector-error-${item.id}` : undefined} data-connected={done ? '' : undefined} data-error={error ? '' : undefined} onClick={() => choose(item)}>
      <span className="connector-logo-slot" aria-hidden="true">{item.icon && <img className="connector-logo" src={item.icon} alt="" width={32} height={32} />}</span><span className="connector-name">{item.name}</span><span className="connector-tile-status" aria-hidden="true"><Icon name={done || busy ? 'check' : 'plus'} className={done || busy ? 'signal-mark' : undefined} /></span>
    </Button>{item.setup&&<p className="connector-tile-note">{item.setup.requirement || 'Setup required'}</p>}{error && <p id={`connector-error-${item.id}`} className="connector-tile-error" role="alert">{error}</p>}</li>;
  };
  // Connectors that can start now come first; the rest say what they are waiting for.
  const ready = matches.filter(item => !item.setup), locked = matches.filter(item => item.setup);
  const grouped = ready.length > 0 && locked.length > 0;
  const unlock = locked.find(item => item.setup?.credential)?.setup?.credential;
  // Sources are optional: a quiet Skip for now continues until a connection is confirmed, even if the catalog failed to load.
  return <OnboardingShell step="sources" backUrl="/onboarding" nextUrl="/onboarding/invite" nextVisible={!resource.loading} nextLabel={connected ? 'Next' : 'Skip for now'} nextPrimary={connected}>
    <section aria-labelledby="sources-title">
      <h1 id="sources-title" tabIndex={-1}>Connect your sources</h1>
      <p className="focus-description">Connect a source to give your agent more context. You can also add one later.</p>
      <div className="connector-search" hidden={!showSearch}><Icon name="search" /><label className="sr-only" htmlFor="connector-query">Search connectors</label><Input ref={queryField} id="connector-query" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${items.length} connectors…`} autoComplete="off" maxLength={100} aria-controls="connector-list" disabled={resource.loading} /></div>
      <div className="connector-catalog" aria-busy={resource.loading}>
        {resource.loading ? <p id="sources-loading" className="connector-message" role="status"><span className="signal-mark connector-spinner" aria-hidden="true" />Loading connectors…</p>
          : resource.error ? <div className="connector-message"><p role="alert">We couldn’t load your connectors.</p><Button onClick={resource.reload}>Try again</Button></div>
            : matches.length ? grouped ? <div id="connector-list" className="connector-groups">
              <section aria-labelledby="connectors-ready"><h2 id="connectors-ready" className="connector-group-title">Ready to connect</h2><ul className="connector-grid" aria-labelledby="connectors-ready">{ready.map(tile)}</ul></section>
              <section aria-labelledby="connectors-setup"><h2 id="connectors-setup" className="connector-group-title">Needs one-time setup</h2>{unlock && <p className="connector-group-note">One {unlock.name} key unlocks {listPhrase(unlock.unlocks)}.</p>}<ul className="connector-grid" aria-labelledby="connectors-setup">{locked.map(tile)}</ul></section>
            </div> : <ul id="connector-list" className="connector-grid" aria-label="Connectors">{matches.map(tile)}</ul> : <div className="connector-message"><p>No connectors found</p>{query && <Button variant="quiet" onClick={() => {setQuery(''); queryField.current?.focus();}}>Clear search</Button>}</div>}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement || (showSearch && query ? `${matches.length} ${matches.length === 1 ? 'connector' : 'connectors'} found` : '')}</p>
    </section>
    <ConnectorSetupDialog source={setupSource} canConfigure={canConfigure} busy={saving} error={setupError} onSave={adapter.saveCredential ? (id, value) => void saveCredential(id, value) : undefined} onClose={() => setSetupSource(null)} />
    <Dialog open={Boolean(secretSource)} onClose={closeSecret} title={secretSource?.keyHelp?.title || `Connect ${secretSource?.name ?? 'source'}`} description={secretSource?.keyHelp?.body || 'Use your workspace API key.'}>
      <form onSubmit={submitSecret}><Field label={secretSource?.keyHelp?.label || 'API key'}><Input ref={secretField} type="password" value={secret} onChange={event => setSecret(event.target.value)} placeholder={secretSource?.keyHelp?.placeholder} autoComplete="off" required /></Field><div className="dialog-actions"><Button variant="quiet" onClick={closeSecret}>Cancel</Button><Button variant="primary" type="submit" disabled={!secret.trim()}>Connect {secretSource?.name}</Button></div></form>
    </Dialog>
  </OnboardingShell>;
}
