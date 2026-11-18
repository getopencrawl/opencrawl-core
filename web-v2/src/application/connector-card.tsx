import {Button, IntegrationCard, IntegrationLogo} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {ago as relativeTime} from '../pages/usage-model.ts';
import {sourceStatus, sourceProgress} from './source-model.ts';
import type {SourceCard} from './api.ts';
import {sourceConnected} from './connector-card-model.ts';

export interface ConnectorCardProps {
  source: SourceCard;
  action?: string;
  pending?: boolean;
  busy?: boolean;
  onAction: () => void;
}
const providerIcon = (source: SourceCard) => `/assets/integrations/${encodeURIComponent(source.provider)}.svg`;
export function ProviderIcon({source}: {source: SourceCard}) {
  return <IntegrationLogo src={providerIcon(source)}/>;
}
export function SourceStats({source}: {source: SourceCard}) {
  return <dl className="oc-source-counts" aria-label={`${source.name} imported data`}>{source.rows?.map(row => {
    const done = !source.statusUnavailable && (row.done || source.state === 'synced');
    const importing = !source.statusUnavailable && source.state === 'syncing' && !done;
    return <div key={row.label} data-done={Boolean(done)}><dt>{row.label}<span className="sr-only">: {source.statusUnavailable ? 'Last measured' : done ? 'Up to date' : importing ? 'Importing' : 'Import incomplete'}</span>{importing && <Icon name="loader" className="oc-spin" size={12}/>}</dt><dd>{row.count.toLocaleString('en-US')}</dd></div>;
  })}</dl>;
}
export function SourceProgress({source}: {source: SourceCard}) {
  const measured = source.initial !== false && source.total !== undefined && source.total !== null && source.total > 0 && source.synced !== undefined;
  return <div className="oc-source-message" data-state={source.state}><p>{sourceProgress(source)}</p>{source.state === 'syncing' && <progress aria-label={`${source.name} import progress`} {...(measured ? {value:Math.max(0,Math.min(source.synced!,source.total!)),max:source.total!} : {})}/>}</div>;
}

/** Adapt imported measurements to the same card used by Usage's indexed content. */
export function ConnectorCard({source, action, pending = false, busy = false, onAction}: ConnectorCardProps) {
  const compact = !sourceConnected(source);
  const status = sourceStatus(source);
  if (!source.statusUnavailable && source.state === 'synced') status.label = 'Synced';
  const lastSynced = source.lastSyncedAt && Number.isFinite(Date.parse(source.lastSyncedAt)) ? source.lastSyncedAt : null;
  const waitingForStatus = source.statusUnavailable || source.statusUpdatedAt === null;
  const showProgress = waitingForStatus || ['syncing', 'error', 'connecting'].includes(source.state);
  return <IntegrationCard name={source.name} icon={providerIcon(source)} compact={compact} status={status}
    metrics={source.rows?.map(row => {
      const done = !source.statusUnavailable && (row.done || source.state === 'synced');
      const importing = !source.statusUnavailable && source.state === 'syncing' && !done;
      return {label: row.label, count: row.count, hint: source.statusUnavailable ? 'Last measured' : done ? 'Up to date' : importing ? 'Importing' : 'Import incomplete', pending: importing};
    })}
    metricsLabel={`${source.name} imported data`}
    note={showProgress ? <SourceProgress source={source}/> : undefined}
    emptyMessage={showProgress ? undefined : source.synced === undefined ? 'Updating imported counts…' : 'No imported data yet.'}
    metadata={<span title={source.statusUnavailable && source.statusUpdatedAt ? `Last measured ${relativeTime(source.statusUpdatedAt)}` : undefined}>{!source.statusUnavailable && source.state === 'synced' && lastSynced ? `Synced ${relativeTime(lastSynced)}` : status.label}</span>}
    action={action && <Button variant={action === 'Connect' ? 'primary' : 'secondary'} disabled={pending} busy={busy} onClick={onAction} aria-label={`${action} ${source.name}`}>{busy ? 'Connecting…' : action}{!compact && source.state !== 'error' && <Icon name="chevron-right" size={14}/>}</Button>}/>;
}
