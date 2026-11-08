import {useEffect, useRef, useState} from 'react';
import {ActivityChart, BarList, Button, EmptyState, LoadingState, MetricGrid, Notice, PageHeader, Section, StatusBadge, Table} from '../design/components.js';
import {Link} from '../router.js';
import type {ConsoleDataAdapter, UsageReport} from './types.js';
import {ago, compact, count, harnessName, memberName, originName, plural, sortedMembers, sourceStatus, speciesLabel, topMember} from './usage-model.ts';
import type {UsageMember, UsageSource} from './usage-model.ts';

export {count} from './usage-model.ts';

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
  const latest = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const request = ++latest.current;
    const current = () => request === latest.current && !controller.signal.aborted;
    setLoading(true);
    setError('');
    setData(null);
    void (async () => {
      try {
        const report = await adapter.usage(controller.signal);
        if (current()) setData(report);
      } catch (failure: unknown) {
        if (current()) setError(failure instanceof Error ? failure.message : 'Usage could not load. Try again.');
      } finally {
        if (current()) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [adapter, revision]);

  return {data, error, loading, refresh: () => setRevision(value => value + 1)};
}

/** Compact source table retained for existing non-report consumers. */
export function SourcesSummary({data}: {data: UsageReport}) {
  if (!data.ingestion) return <Notice tone="warning">Source reporting is unavailable. Refresh to try again.</Notice>;
  if (!data.ingestion.sources.length) {
    return <EmptyState title="Connect your first source" description="Give your agents access to your team’s knowledge." actions={<Link to="/sources">Connect a source</Link>}/>;
  }
  return (
    <Table label="Connected source status">
      <thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Imported</th><th scope="col">Indexed</th><th scope="col">Last sync</th></tr></thead>
      <tbody>{data.ingestion.sources.map(source => (
        <tr key={source.name}>
          <th scope="row">{source.name}{source.account && <span className="muted block">{source.account}</span>}</th>
          <td><StatusBadge tone={source.state === 'synced' ? 'success' : source.state === 'error' ? 'danger' : 'neutral'}>{source.state}</StatusBadge></td>
          <td>{count(source.records)}</td><td>{count(source.indexed)}</td><td>{date(source.lastSyncedAt)}</td>
        </tr>
      ))}</tbody>
    </Table>
  );
}

function SourceCard({source, now}: {source: UsageSource; now: number}) {
  const status = sourceStatus(source.state);
  const units = source.units || ['record', 'records'];
  const species = source.indexedSpecies;
  const importedRows = source.rows || [];

  return (
    <article className="report-source-card" aria-label={source.name}>
      <header className="report-source-header">
        <img src={source.icon} alt="" width={28} height={28}/>
        <div className="report-source-identity"><h3>{source.name}</h3>{source.account && <p>{source.account}</p>}</div>
        <StatusBadge variant="pill" tone={status.tone}>{status.label}</StatusBadge>
      </header>
      <p className="report-source-count"><strong>{count(source.indexed)}</strong> indexed {source.indexed === 1 ? 'document' : 'documents'}</p>
      <div>
        <h4 className="report-source-label">Indexed content</h4>
        {species ? species.length ? (
          <ul className="report-source-rows report-indexed-species" aria-label={`Indexed content in ${source.name}`}>
            {species.map(item => <li key={item.name}><span>{speciesLabel(item.name)}</span><span>{count(item.count)}</span></li>)}
          </ul>
        ) : <p className="report-note">No indexed content yet.</p> : <p className="report-note">Indexed breakdown unavailable.</p>}
      </div>
      <div className="report-source-imported">
        <p><strong>Imported</strong> {count(source.records)} {source.records === 1 ? units[0] : units[1]}</p>
        {importedRows.length > 0 && (
          <ul className="report-source-rows" aria-label={`Imported records from ${source.name}`}>
            {importedRows.map(row => <li key={row.label}><span>{row.label}</span><span>{count(row.count)}</span></li>)}
          </ul>
        )}
      </div>
      <p className="report-source-meta">
        <span>{source.lastSyncedAt ? `Synced ${ago(source.lastSyncedAt, now)}` : 'Not synced yet'}</span>
        {source.connectedBy && <span>Connected by {source.connectedBy}</span>}
      </p>
    </article>
  );
}

function DataSourcesReport({report, now}: {report: UsageReport; now: number}) {
  const data = report.ingestion;
  return (
    <Section className="report-section" title="Data sources" description="Imported records and indexed documents are measured separately for each source.">
      {!data ? <EmptyState title="Source reporting isn’t available on this deployment."/> : data.sources.length ? (
        <div className="report-source-grid">
          {data.sources.map((source, index) => <SourceCard key={`${source.name}:${source.account || index}`} source={source} now={now}/>)}
        </div>
      ) : <EmptyState title="No sources connected" actions={<Link to="/sources">Connect a source to start ingesting.</Link>}/>}
    </Section>
  );
}

function AgentReport({report, now}: {report: UsageReport; now: number}) {
  const data = report.agents;
  const people = data?.people?.length;
  const daily = data?.daily || [];
  const activeDays = daily.filter(day => day.events > 0).length;
  const busiest = daily.reduce<(typeof daily)[number] | undefined>((best, day) => !best || day.sessions > best.sessions ? day : best, undefined);

  return (
    <Section className="report-section" title="Agent sessions" description={report.days ? `Captured activity over the last ${report.days} days.` : 'Captured agent activity.'}>
      {!data ? <EmptyState title="Agent reporting isn’t available on this deployment."/> : <>
        <MetricGrid items={[
          {label: 'Sessions', value: compact(data.sessions), note: `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}`, title: count(data.sessions)},
          {label: 'Messages', value: compact(data.messages), note: 'prompts and replies captured', title: count(data.messages)},
          {label: 'Tool calls', value: compact(data.toolCalls), note: 'tools used across captured sessions', title: count(data.toolCalls)},
          {label: 'Machines', value: count(data.machines), note: people != null ? `${plural(people, 'person', 'people')} capturing` : 'capturing agent sessions'},
        ]}/>
        <p className="report-note">
          OpenCrawl tool calls: <strong>{count(data.opencrawlCalls)}</strong> · Last capture: <strong>{data.lastAt ? ago(data.lastAt, now) : 'Not yet'}</strong>
          {data.firstAt && <> · Capturing since {data.firstAt.slice(0, 10)}</>}
        </p>
        {data.events === 0 ? (
          <EmptyState title="No agent sessions captured yet." description="Once teammates install the OpenCrawl CLI, their Claude Code and Codex sessions appear here."/>
        ) : <>
          <Section className="report-panel" headingLevel={3} title="Daily agent sessions" description={busiest && busiest.sessions > 0 ? `Busiest day: ${busiest.date} with ${plural(busiest.sessions, 'session')}.` : undefined}>
            <ActivityChart daily={data.daily}/>
          </Section>
          <div className="report-split">
            <Section className="report-panel" headingLevel={3} title="Where agents run" description="Captured events by agent and surface.">
              <BarList rows={data.harnesses.map(row => ({...row, name: harnessName(row.name)}))} label="Captured events by agent"/>
              <BarList rows={data.origins.map(row => ({...row, name: originName(row.name)}))} label="Captured events by surface"/>
            </Section>
            <Section className="report-panel" headingLevel={3} title="Tools" description="Most used tools across captured sessions.">
              <BarList rows={data.tools.map(row => ({...row, name: row.name.replace(/^mcp__/, '').replace(/__/g, ' · ')}))} label="Most used agent tools"/>
            </Section>
          </div>
        </>}
      </>}
    </Section>
  );
}

function SetupDots({member}: {member: UsageMember}) {
  const labels = {cli: 'CLI', mcp: 'MCP', session: 'Sessions'};
  return <>
    <span className="report-setup-dots">{(['cli', 'mcp', 'session'] as const).map(key => (
      <span key={key} className={`report-setup-dot${member.setup[key] ? ' is-complete' : ''}`} role="img"
        aria-label={`${labels[key]} ${member.setup[key] ? 'set up' : 'not set up'}`}
        title={`${labels[key]} ${member.setup[key] ? 'set up' : 'not set up'}`}/>
    ))}</span>
    {member.setup.client && <span className="report-email">{member.setup.client}</span>}
  </>;
}

function TeamReport({report, now}: {report: UsageReport; now: number}) {
  const members = report.members;
  const integrator = topMember(members, 'sources');
  const user = topMember(members, 'sessions');
  const builder = topMember(members, 'toolCalls');
  const active = members.filter(member => member.weekEvents > 0).length;
  const highlights = [
    {label: 'Most sources connected', member: integrator, value: integrator && plural(integrator.sources, 'source')},
    {label: 'Most sessions', member: user, value: user && plural(user.sessions, 'session')},
    {label: 'Most tool calls', member: builder, value: builder && plural(builder.toolCalls, 'tool call')},
  ];

  return (
    <Section className="report-section" title="Team" description={members.length ? `${active} of ${plural(members.length, 'member')} active this week.` : undefined}>
      {!members.length ? <EmptyState title="Team reporting isn’t available on this deployment."/> : <>
        {highlights.some(item => item.member) && (
          <dl className="report-highlights">{highlights.map(item => item.member ? (
            <div key={item.label} className="report-highlight">
              <dt>{item.label}</dt><dd><strong>{memberName(item.member)}</strong><span>{item.value}</span></dd>
            </div>
          ) : null)}</dl>
        )}
        <Section className="report-panel" headingLevel={3} title="Member activity" description={`${report.days ? `Last ${report.days} days.` : 'All captured activity.'} Ranked by sessions, then tool calls. Setup: CLI, MCP, sessions.`}>
          <Table label="Team usage" className="report-member-table report-leaderboard-table">
            <thead><tr>
              <th scope="col">Rank</th><th scope="col">Member</th><th scope="col">Sessions</th><th scope="col">Messages</th>
              <th scope="col">Tool calls</th><th scope="col">Sources</th><th scope="col">Setup</th><th scope="col">Last active</th>
            </tr></thead>
            <tbody>{sortedMembers(members).map((member, index) => (
              <tr key={member.email}>
                <td>{index + 1}</td>
                <th scope="row"><span className="report-member">{memberName(member)}{member.you && <em>you</em>}</span>{member.name && <span className="report-email">{member.email}</span>}</th>
                <td>{count(member.sessions)}</td><td>{count(member.messages)}</td><td>{count(member.toolCalls)}</td><td>{count(member.sources)}</td>
                <td><SetupDots member={member}/></td><td>{member.lastAt ? ago(member.lastAt, now) : 'not yet'}</td>
              </tr>
            ))}</tbody>
          </Table>
        </Section>
      </>}
    </Section>
  );
}

export function UsageReportView({data, now = Date.now()}: {data: UsageReport; now?: number}) {
  return <>
    <AgentReport report={data} now={now}/>
    <DataSourcesReport report={data} now={now}/>
    <TeamReport report={data} now={now}/>
  </>;
}

export function UsagePage({adapter}: {adapter: ConsoleDataAdapter}) {
  const {data, error, loading, refresh} = useUsage(adapter);
  const now = Date.now();
  const scope = data ? [data.workspace, data.days ? `last ${data.days} days` : '', `updated ${ago(data.generatedAt, now)}`].filter(Boolean).join(' · ') : 'Workspace usage';
  return (
    <div className="usage-report">
      <PageHeader variant="report" title="Usage" description={scope}/>
      {error && <Notice tone="danger">{error} <Button onClick={refresh} disabled={loading}>Try again</Button></Notice>}
      {loading && <LoadingState label="Loading usage"/>}
      {data && <UsageReportView data={data} now={now}/>}
    </div>
  );
}
