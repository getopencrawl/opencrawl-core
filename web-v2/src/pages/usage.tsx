import {useEffect, useState} from 'react';
import {Button, EmptyState, LoadingState, Notice, PageHeader, Section, StatusBadge, Table, Tabs} from '../design/components.js';
import {Link, useLocation, useNavigate} from '../router.js';
import type {ConsoleDataAdapter, UsageReport} from './types.js';

export const count = (value: number | null | undefined) => value == null ? 'Unavailable' : new Intl.NumberFormat().format(value);
export function date(value: string | number | null | undefined) {
  if (value == null) return 'Not yet';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'Unknown' : parsed.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
}
export function useUsage(adapter: ConsoleDataAdapter) {
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    adapter.usage(controller.signal).then(setData).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Usage could not load. Try again.');
    }).finally(() => {if (!controller.signal.aborted) setLoading(false);});
    return () => controller.abort();
  }, [adapter, revision]);
  return {data, error, loading, refresh: () => setRevision(value => value + 1)};
}
export function SourcesSummary({data}: {data: UsageReport}) {
  if (!data.ingestion) return <Notice tone="warning">Source reporting is unavailable. Refresh to try again.</Notice>;
  if (!data.ingestion.sources.length) return <EmptyState title="Connect your first source" description="Give your agents access to your team’s knowledge." actions={<Link to="/sources">Connect a source</Link>}/>;
  return <Table label="Connected source status"><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Imported</th><th scope="col">Indexed</th><th scope="col">Last sync</th></tr></thead><tbody>{data.ingestion.sources.map(source => <tr key={source.name}><th scope="row">{source.name}{source.account && <span className="muted block">{source.account}</span>}</th><td><StatusBadge tone={source.state === 'synced' ? 'success' : source.state === 'error' ? 'danger' : 'neutral'}>{source.state}</StatusBadge></td><td>{count(source.records)}</td><td>{count(source.indexed)}</td><td>{date(source.lastSyncedAt)}</td></tr>)}</tbody></Table>;
}
export function UsagePage({adapter}: {adapter: ConsoleDataAdapter}) {
  const {data, error, loading, refresh} = useUsage(adapter);
  const location = useLocation(), navigate = useNavigate();
  const tab = new URLSearchParams(location.search).get('tab') || 'ingestion';
  return <><PageHeader title="Usage" description="Understand what your workspace has collected and how your team uses it." actions={<Button onClick={refresh} disabled={loading}>Refresh</Button>}/><Tabs label="Usage reports" value={tab} onChange={value => navigate('/usage?tab=' + value)} items={[{value:'ingestion', label:'Data'},{value:'agents',label:'Agent activity'},{value:'team',label:'Team activity'}]}/>{error && <Notice tone="danger">{error}</Notice>}{loading && <LoadingState label="Loading usage"/>}{data && <>
    {tab === 'ingestion' && <><Section title="Connected sources" description="Imported records and indexed documents are measured separately."><SourcesSummary data={data}/></Section><Section title="Index inventory" description="Current indexed totals, across the lifetime of this workspace.">{data.ingestion?.index ? <Table label="Index inventory"><thead><tr><th scope="col">Content</th><th scope="col">Indexed documents</th></tr></thead><tbody><tr><th scope="row">Agent session events</th><td>{count(data.ingestion.index.sessionEvents)}</td></tr>{data.ingestion.index.sources.map(source => <tr key={source.name}><th scope="row">{source.name}</th><td>{count(source.count)}</td></tr>)}</tbody></Table> : <Notice>Index inventory is unavailable.</Notice>}</Section></>}
    {tab === 'agents' && <Section title={`Agent activity in the last ${data.days} days`} description="Activity counts cover this reporting window. They differ from lifetime indexed totals.">{data.agents ? <><dl className="metric-list"><div><dt>Sessions</dt><dd>{count(data.agents.sessions)}</dd></div><div><dt>Messages</dt><dd>{count(data.agents.messages)}</dd></div><div><dt>Tool calls</dt><dd>{count(data.agents.toolCalls)}</dd></div><div><dt>Machines</dt><dd>{count(data.agents.machines)}</dd></div></dl><Table label="Daily agent activity"><thead><tr><th scope="col">Day</th><th scope="col">Sessions</th><th scope="col">Events</th></tr></thead><tbody>{data.agents.daily.map(day => <tr key={day.date}><th scope="row">{day.date}</th><td>{count(day.sessions)}</td><td>{count(day.events)}</td></tr>)}</tbody></Table>{!data.agents.daily.length && <EmptyState title="No activity in this window" description="Connect your agent from Settings to start capturing sessions."/>}<Table label="Tools used"><thead><tr><th scope="col">Tool</th><th scope="col">Calls</th></tr></thead><tbody>{data.agents.tools.map(tool => <tr key={tool.name}><th scope="row">{tool.name}</th><td>{count(tool.count)}</td></tr>)}</tbody></Table></> : <Notice tone="warning">Agent activity is unavailable. Refresh to try again.</Notice>}</Section>}
    {tab === 'team' && <Section title="Team activity" description={`Activity over the last ${data.days} days, scoped to this workspace.`}><Table label="Team activity"><thead><tr><th scope="col">Member</th><th scope="col">Agent setup</th><th scope="col">Sessions</th><th scope="col">Sources</th><th scope="col">Last activity</th></tr></thead><tbody>{data.members.map(member => <tr key={member.email}><th scope="row">{member.name || member.email}{member.you ? ' (you)' : ''}<span className="muted block">{member.name ? member.email : ''}</span></th><td><StatusBadge tone={member.setup.cli && member.setup.mcp && member.setup.session ? 'success' : 'neutral'}>{member.setup.cli && member.setup.mcp && member.setup.session ? 'Connected' : 'Incomplete'}</StatusBadge></td><td>{count(member.sessions)}</td><td>{count(member.sources)}</td><td>{date(member.lastAt)}</td></tr>)}</tbody></Table></Section>}
    <p className="muted">Updated {date(data.generatedAt)}</p></>}</>;
}
