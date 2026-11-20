import type {ReactNode} from 'react';
import {Button, IntegrationCard, IntegrationLogo} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {ago as relativeTime} from '../pages/usage-model.ts';
import {initialImport, sourceStatus, sourceProgress} from './source-model.ts';
import type {SourceCard} from './api.ts';
import {sourceConnected} from './connector-card-model.ts';

export interface ConnectorCardProps {
  source: SourceCard;
  action?: string;
  actionLink?: ReactNode;
  pending?: boolean;
  busy?: boolean;
  onAction: () => void;
}
const providerIcon = (source: SourceCard) => `/assets/integrations/${encodeURIComponent(source.provider)}.svg`;
export function ProviderIcon({source}: {source: SourceCard}) {
  return <IntegrationLogo src={providerIcon(source)}/>;
}
function streamStatus(source: SourceCard, row: NonNullable<SourceCard['rows']>[number]) {
  const done = !source.statusUnavailable && Boolean(row.done || source.state === 'synced');
  const waiting = source.provider === 'replicas' && source.state === 'syncing' && source.history?.waitingForSource;
  const pending = !waiting && !source.statusUnavailable && source.state === 'syncing' && !done;
  const hint = source.statusUnavailable ? 'Last measured' : waiting ? 'Imported' : done ? 'Up to date' : pending ? sourceStatus(source).label : 'Import incomplete';
  return {done, pending, hint};
}
export function SourceStats({source}: {source: SourceCard}) {
  return <dl className="oc-source-counts" aria-label={`${source.name} imported data`}>{source.rows?.map(row => {
    const {done, pending, hint} = streamStatus(source, row);
    return <div key={row.label} data-done={done}><dt>{row.label}<span className="sr-only">: {hint}</span>{pending && <Icon name="loader" className="oc-spin" size={12}/>}</dt><dd>{row.count.toLocaleString('en-US')}</dd></div>;
  })}</dl>;
}
export function SourceProgress({source}: {source: SourceCard}) {
  return <div className="oc-source-message" data-state={source.state}><p>{sourceProgress(source)}</p></div>;
}

/** Adapt imported measurements to the same card used by Usage's indexed content. */
export function ConnectorCard({source, action, actionLink, pending = false, busy = false, onAction}: ConnectorCardProps) {
  const compact = !sourceConnected(source);
  const status = sourceStatus(source);
  if (!source.statusUnavailable && source.state === 'synced') status.label = 'Synced';
  const lastSynced = source.lastSyncedAt && Number.isFinite(Date.parse(source.lastSyncedAt)) ? source.lastSyncedAt : null;
  const waitingForStatus = source.statusUnavailable || source.statusUpdatedAt === null;
  const measuredImport = initialImport(source) && (Boolean(source.total) || source.finishing);
  const showProgress = waitingForStatus || measuredImport || source.state === 'error' || source.state === 'connecting';
  return <IntegrationCard name={source.name} icon={providerIcon(source)} compact={compact} status={status}
    metrics={source.rows?.map(row => ({label: row.label, count: row.count, ...streamStatus(source, row)}))}
    metricsLabel={`${source.name} imported data`}
    note={showProgress ? <SourceProgress source={source}/> : undefined}
    emptyMessage={showProgress || source.state === 'syncing' ? undefined : source.synced === undefined ? 'Updating imported counts…' : 'No imported data yet.'}
    metadata={<span title={source.statusUnavailable && source.statusUpdatedAt ? `Last measured ${relativeTime(source.statusUpdatedAt)}` : undefined}>{!source.statusUnavailable && source.state === 'synced' && lastSynced ? `Synced ${relativeTime(lastSynced)}` : status.label}</span>}
    action={actionLink ?? (action && <Button variant={action === 'Connect' ? 'primary' : 'secondary'} disabled={pending} busy={busy} onClick={onAction} aria-label={`${action} ${source.name}`}>{busy ? 'Connecting…' : action}{!compact && source.state !== 'error' && <Icon name="chevron-right" size={14}/>}</Button>)}/>;
}
