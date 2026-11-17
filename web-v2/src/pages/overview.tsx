import {Button, CopyField, Notice, Page, Section, StatusBadge} from '../design/components.js';
import {Link} from '../router.js';
import {count, date, SourcesSummary, useUsage} from './usage.js';
import type {ConsoleDataAdapter} from './types.js';
import {LoadingState} from '../design/components.js';
export function OverviewPage({adapter, mcpUrl}: {adapter: ConsoleDataAdapter; mcpUrl: string}) {
  const {data, error, loading, refresh} = useUsage(adapter);
  const issues = data?.ingestion?.sources.filter(source => ['error','unavailable'].includes(source.state)) || [];
  return <Page title="Overview" description="Manage the knowledge your agents work with." actions={<Button onClick={refresh} disabled={loading}>Refresh</Button>}>{error && <Notice tone="danger">{error}</Notice>}{loading && <LoadingState label="Loading workspace"/>}{data && <>
  {issues.length > 0 && <Notice tone="warning">{issues.length} {issues.length === 1 ? 'source needs' : 'sources need'} attention. <Link to="/sources">Review sources</Link></Notice>}
  <Section title="Workspace activity" description={`Activity over the last ${data.days} days.`}><dl className="metric-list"><div><dt>Agent sessions</dt><dd>{count(data.agents?.sessions)}</dd></div><div><dt>Connected sources</dt><dd>{data.ingestion ? count(data.ingestion.sources.length) : 'Unavailable'}</dd></div><div><dt>Team members</dt><dd>{count(data.members.length)}</dd></div></dl><p className="muted">Latest agent activity: {date(data.agents?.lastAt)}. <Link to="/usage">View usage</Link></p></Section>
  <Section title="Sources" actions={<Link to="/sources">Manage sources</Link>}><SourcesSummary data={data}/></Section>
  <Section title="Agent connection" description="Your agents search OpenCrawl through this workspace’s MCP connection."><CopyField label="MCP endpoint" value={mcpUrl}/><div className="action-row"><Link to="/settings">Configure your agent</Link><Link to="/diagnostics">Inspect diagnostics</Link></div></Section>
  <Section title="Index response time" description="Median duration of three live index probes; this measures the search engine, not end-to-end agent latency."><StatusBadge tone={data.ingestion?.index?.searchMs != null ? 'success' : 'neutral'}>{data.ingestion?.index?.searchMs != null ? `${count(data.ingestion.index.searchMs)} ms` : 'Unavailable'}</StatusBadge></Section>
  <p className="muted">Updated {date(data.generatedAt)}</p></>}</Page>;
}
