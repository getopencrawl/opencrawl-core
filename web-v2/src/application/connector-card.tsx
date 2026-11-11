import {useId, useState} from 'react';
import {Button} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {ago as relativeTime} from '../pages/usage-model.ts';
import {sourceStatus, sourceProgress} from './source-model.ts';
import type {SourceCard} from './api.ts';
import {headlineMetric} from './connector-card-model.ts';

export interface ConnectorCardProps {
  source: SourceCard;
  /** Catalog-owned semantic metric. If absent or not available, use the largest count. */
  primaryMetric?: string;
  action: string;
  pending?: boolean;
  onAction: () => void;
}
export function ProviderIcon({source}: {source: SourceCard}) {
  const [failed, setFailed] = useState(false);
  return !failed
    ? <img className="oc-connector-icon" src={`/assets/integrations/${encodeURIComponent(source.provider)}.svg`} width="32" height="32" alt="" onError={()=>setFailed(true)}/>
    : <span className="oc-connector-placeholder" aria-hidden="true"><Icon name="sources" size={22}/></span>;
}
export function SourceStats({source}: {source: SourceCard}) {
  return <dl className="oc-source-counts" aria-label={`${source.name} imported data`}>{source.rows?.map(row => {
    const done = row.done || source.state === 'synced';
    const importing = source.state === 'syncing' && !done;
    return <div key={row.label} data-done={Boolean(done)}><dt>{row.label}<span className="sr-only">: {done ? 'Up to date' : importing ? 'Importing' : 'Import incomplete'}</span>{importing && <Icon name="loader" className="oc-spin" size={12}/>}</dt><dd>{row.count.toLocaleString('en-US')}</dd></div>;
  })}</dl>;
}
export function SourceProgress({source}: {source: SourceCard}) {
  const measured = source.initial !== false && source.total !== undefined && source.total !== null && source.total > 0 && source.synced !== undefined;
  return <div className="oc-source-message" data-state={source.state}><p>{sourceProgress(source)}</p>{source.state === 'syncing' && <progress aria-label={`${source.name} import progress`} {...(measured ? {value:Math.max(0,Math.min(source.synced!,source.total!)),max:source.total!} : {})}/>}</div>;
}

/** One card for every provider and state. Only an explicit disclosure changes height. */
export function ConnectorCard({source, primaryMetric, action, pending = false, onAction}: ConnectorCardProps) {
  const [expanded, setExpanded] = useState(false);
  const statsId = useId();
  const titleId = useId();
  const status = sourceStatus(source);
  const headline = headlineMetric(source.rows, primaryMetric);
  const more = Math.max(0, (source.rows?.length ?? 0) - (headline ? 1 : 0));
  const available = source.state === 'disconnected' || source.state === 'setup-required';
  const description = source.account || (source.scope === 'user' ? 'Personal connection' : 'Workspace connection');
  const lastSynced = source.lastSyncedAt && Number.isFinite(Date.parse(source.lastSyncedAt)) ? source.lastSyncedAt : null;
  const statusHint = ['syncing','error','connecting','setup-required','unavailable'].includes(source.state) ? sourceProgress(source) : lastSynced ? new Date(lastSynced).toLocaleString() : status.label;
  const metricText = headline ? new Intl.NumberFormat('en-US', headline.count >= 1_000_000 ? {notation:'compact',maximumFractionDigits:1} : {}).format(headline.count) : '';
  return <article className="oc-connector-card" aria-label={source.name} data-state={source.state} data-expanded={expanded}>
    <div className="oc-connector-summary">
      <header className="oc-connector-heading"><ProviderIcon source={source}/><div><h2 id={titleId} title={source.name}>{source.name}</h2><p title={description ?? undefined}>{description}</p></div></header>
      <div className="oc-connector-content">
        {headline ? <>
          <dl className="oc-connector-headline"><dt title={headline.label}>{headline.label}</dt><dd title={headline.count.toLocaleString('en-US')} aria-label={headline.count.toLocaleString('en-US')}>{metricText}</dd></dl>
          {more>0 && <Button className="oc-connector-more" variant="plain" aria-expanded={expanded} aria-controls={statsId} aria-label={`${expanded ? 'Show fewer stats' : `Show ${more} more stats`} for ${source.name}`} onClick={()=>setExpanded(value=>!value)}>{expanded ? 'Show less' : `${more} more`}<Icon name="chevron-down" size={14}/></Button>}
        </> : <p className="oc-connector-description">{available ? source.description : source.state==='syncing' ? 'Your first import is starting. Counts will appear here.' : ['error','connecting','unavailable'].includes(source.state) ? sourceProgress(source) : source.synced === undefined ? 'Updating imported counts…' : 'No imported data yet.'}</p>}
      </div>
      <footer className="oc-connector-footer"><span data-tone={status.tone} title={statusHint}>{source.state==='syncing'||source.state==='connecting'?<Icon name="loader" className="oc-spin" size={12}/>:<span className="oc-connector-dot" aria-hidden="true"/>}<span>{source.state==='synced' && lastSynced ? <>Synced <time dateTime={lastSynced}>{relativeTime(lastSynced)}</time></> : status.label}</span></span><Button variant={available || source.state==='error' ? 'secondary' : 'quiet'} disabled={pending} onClick={onAction} aria-label={`${action} ${source.name}`}>{action}{!available&&source.state!=='error'&&<Icon name="chevron-right" size={14}/>}</Button></footer>
    </div>
    {more>0 && <div id={statsId} className="oc-connector-details" hidden={!expanded}><h3>Imported data</h3><SourceStats source={source}/>{source.state==='syncing'&&<SourceProgress source={source}/>} </div>}
  </article>;
}
