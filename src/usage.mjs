// Usage and reporting: what came in, how agents work, and who on the team uses OpenCrawl.
// Renders a neutral report; each runtime supplies the numbers it can measure.
// No inline styles: the product CSP is style-src 'self', so bars are SVG geometry.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const full = n => Number(n || 0).toLocaleString('en-US');
const compact = n => {
  const value = Number(n || 0);
  if (value < 10000) return full(value);
  const [div, unit] = value >= 1e9 ? [1e9, 'B'] : value >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
  return (value / div).toFixed(value / div >= 100 ? 0 : 1).replace(/\.0$/, '') + unit;
};
const plural = (n, one, many = one + 's') => `${full(n)} ${n === 1 ? one : many}`;
const percent = (part, whole) => whole && part ? Math.max(2, Math.round(part / whole * 100)) : 0;
export const TABS = [['ingestion', 'Ingestion'], ['agents', 'Agents'], ['team', 'Team']];

export function ago(iso, now = Date.now()) {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (!iso || Number.isNaN(seconds)) return 'never';
  if (seconds < 60) return 'just now';
  const [value, unit] = seconds < 3600 ? [Math.round(seconds / 60), 'minute'] : seconds < 86400 ? [Math.round(seconds / 3600), 'hour'] : [Math.round(seconds / 86400), 'day'];
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

const kpi = (label, value, note = '', title = '') => `<div class="kpi"><dt>${escape(label)}</dt><dd><span class="kpi-value"${title ? ` title="${escape(title)}"` : ''}>${value}</span>${note ? `<span class="kpi-note">${note}</span>` : ''}</dd></div>`;
const kpis = items => `<dl class="kpis">${items.join('')}</dl>`;
const panel = (title, body, {wide = false, note = ''} = {}) => `<section class="panel${wide ? ' wide' : ''}"><div class="panel-head"><h2>${escape(title)}</h2>${note ? `<p>${note}</p>` : ''}</div>${body}</section>`;
const empty = text => `<p class="empty">${text}</p>`;

function bars(rows, {label = r => r.name, total} = {}) {
  if (!rows.length) return empty('Nothing yet.');
  const max = total ?? Math.max(...rows.map(r => r.count));
  return `<ul class="bars">${rows.map(r => `<li><span class="bar-label">${escape(label(r))}</span><svg class="bar-track" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width="${percent(r.count, max)}" height="6" rx="1"/></svg><span class="bar-count">${full(r.count)}</span></li>`).join('')}</ul>`;
}

/** Daily sessions as an inline SVG column chart; no script needed. */
function chart(daily) {
  if (!daily.length) return empty('No activity yet.');
  const max = Math.max(1, ...daily.map(d => d.sessions)), w = 100 / daily.length;
  const columns = daily.map((d, i) => {
    const h = d.sessions ? Math.max(3, d.sessions / max * 100) : 0;
    return `<rect x="${(i * w + w * .15).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="${(w * .7).toFixed(2)}" height="${h.toFixed(2)}" rx=".6"><title>${escape(d.date)}: ${plural(d.sessions, 'session')}, ${plural(d.events, 'event')}</title></rect>`;
  }).join('');
  const busiest = daily.reduce((a, b) => b.sessions > a.sessions ? b : a);
  return `<figure class="chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Agent sessions per day. Busiest day ${escape(busiest.date)} with ${plural(busiest.sessions, 'session')}.">${columns}</svg><figcaption><span>${escape(daily[0].date)}</span><span>Peak ${plural(max, 'session')} a day</span><span>${escape(daily.at(-1).date)}</span></figcaption></figure>`;
}

const STATE = {synced: ['Synced', 'ok'], syncing: ['Syncing', 'busy'], error: ['Needs attention', 'bad'], connecting: ['Connecting', 'busy'], unavailable: ['Status unavailable', 'bad']};
function source(s, now) {
  const [state, tone] = STATE[s.state] || [s.state, ''];
  const [one, many] = s.units || ['record', 'records'];
  const rows = (s.rows || []).filter(r => r.count);
  return `<article class="source"><header><img src="${escape(s.icon)}" alt="" width="28" height="28"><div><h3>${escape(s.name)}</h3>${s.account ? `<p>${escape(s.account)}</p>` : ''}</div><span class="pill ${tone}">${escape(state)}</span></header>
<p class="source-count"><strong>${full(s.records)}</strong> ${escape(s.records === 1 ? one : many)}</p>
${rows.length ? `<ul class="source-rows">${rows.map(r => `<li><span>${escape(r.label)}</span><span>${full(r.count)}</span></li>`).join('')}</ul>` : ''}
<p class="source-meta"><span class="${s.searchable ? 'searchable' : 'stored'}">${s.searchable ? 'Searchable by agents' : 'Stored, indexing next'}</span><span>Synced ${escape(ago(s.lastSyncedAt, now))}</span>${s.connectedBy ? `<span>Connected by ${escape(s.connectedBy)}</span>` : ''}</p></article>`;
}

function ingestion(r, now) {
  const data = r.ingestion;
  if (!data) return empty('Source reporting isn’t available on this deployment.');
  const sources = data.sources;
  const records = sources.reduce((sum, s) => sum + (s.records || 0), 0);
  const index = data.index || {};
  const searchable = (index.sessionEvents || 0) + (index.connectorDocuments || 0);
  const freshest = sources.map(s => s.lastSyncedAt).filter(Boolean).sort().at(-1);
  const healthy = sources.filter(s => s.state === 'synced' || s.state === 'syncing').length;
  const parts = [
    {name: 'Agent sessions', count: index.sessionEvents || 0},
    ...sources.filter(s => s.searchable).map(s => ({name: s.name, count: s.indexed ?? s.records ?? 0})),
  ].filter(p => p.count);
  const summary = sources.length
    ? `OpenCrawl has brought in <strong>${full(records)} records</strong> from ${plural(sources.length, 'source')}${searchable ? `, and your agents can search <strong>${full(searchable)} documents</strong>` : ''}${index.searchMs != null ? ` in about <strong>${full(index.searchMs)} ms</strong>` : ''}.`
    : 'No sources are connected yet. Connect your team’s tools and their content shows up here.';
  return `<p class="summary">${summary}</p>
${kpis([
    kpi('Records ingested', compact(records), sources.length ? `from ${plural(sources.length, 'source')}` : 'connect a source to start', full(records)),
    kpi('Searchable documents', compact(searchable), 'sessions and indexed sources', full(searchable)),
    kpi('Search speed', index.searchMs != null ? `${full(index.searchMs)}<small>ms</small>` : '—', index.searchMs != null ? 'median, measured just now' : 'measured once the index has data'),
    kpi('Freshness', freshest ? escape(ago(freshest, now)) : '—', `${healthy} of ${plural(sources.length, 'source')} healthy`),
  ])}
${panel('Sources', sources.length ? `<div class="sources">${sources.map(s => source(s, now)).join('')}</div>` : empty(`<a href="${escape(r.integrationsUrl || '/integrations')}">Connect a source</a> to start ingesting.`), {wide: true, note: `${healthy} of ${plural(sources.length, 'connection')} syncing normally.`})}
${panel('What’s in the index', `${bars(parts)}${index.probes?.length ? `<p class="fineprint">Search speed is the time OpenCrawl’s index took to answer ${plural(index.probes.length, 'live query', 'live queries')} scoped to your workspace: ${index.probes.map(ms => full(ms) + ' ms').join(', ')}.</p>` : ''}`, {note: 'Documents agents can retrieve right now, by source.'})}`;
}

function agents(r, now) {
  const u = r.agents;
  if (!u) return empty('Agent reporting isn’t available on this deployment.');
  if (!u.events) return `${empty('No agent sessions captured yet. Once teammates install the OpenCrawl CLI, their Claude Code and Codex sessions appear here.')}${setupPanel(r)}`;
  const people = u.people.length;
  const busiest = u.daily.reduce((a, b) => b.sessions > a.sessions ? b : a, u.daily[0] || {sessions: 0});
  const activeDays = u.daily.filter(d => d.events).length;
  const harness = name => ({'claude-code': 'Claude Code', codex: 'Codex'})[name] || name;
  const origin = name => ({cli: 'Terminal', desktop: 'Desktop app', cloud: 'Cloud', subagent: 'Subagents', unknown: 'Other'})[name] || name;
  return `<p class="summary">${r.team ? 'Your team’s agents' : 'Your agents'} ran <strong>${plural(u.sessions, 'session')}</strong> with <strong>${full(u.toolCalls)} tool calls</strong>${r.days ? ` over the last ${r.days} days` : ''}. Every one is captured as searchable context${people > 1 ? ` for ${full(people)} people` : ''}.</p>
${kpis([
    kpi('Agent sessions', compact(u.sessions), `${activeDays} active ${activeDays === 1 ? 'day' : 'days'}`, full(u.sessions)),
    kpi('Tool calls', compact(u.toolCalls), u.sessions ? `${full(Math.round(u.toolCalls / u.sessions))} per session` : '', full(u.toolCalls)),
    kpi('Messages', compact(u.messages), 'prompts and replies captured', full(u.messages)),
    kpi('Machines', full(u.machines), `${plural(people, 'person', 'people')} capturing`),
  ])}
${panel('Daily agent sessions', chart(u.daily), {wide: true, note: busiest?.sessions ? `Busiest day: ${escape(busiest.date)} with ${plural(busiest.sessions, 'session')}.` : ''})}
<div class="split">${panel('Where agents run', `${bars(u.harnesses, {label: r => harness(r.name)})}${bars(u.origins, {label: r => origin(r.name)})}`, {note: 'Captured events by agent and surface.'})}
${panel('What agents do', bars(u.tools.map(t => ({...t, name: t.name.replace(/^mcp__/, '').replace(/__/g, ' · ')}))), {note: 'Most used tools across captured sessions.'})}</div>
${panel('OpenCrawl in the loop', `${kpis([kpi('OpenCrawl tool calls', full(u.opencrawlCalls), 'agents calling OpenCrawl directly'), kpi('Last capture', escape(ago(u.lastAt, now)), u.firstAt ? `since ${escape(u.firstAt.slice(0, 10))}` : '')])}<p class="fineprint">Search analytics come next: searches per session, hit rate, latency and turns saved, measured as soon as agents query OpenCrawl.</p>`, {wide: true})}
${setupPanel(r)}`;
}

function setupPanel(r) {
  const members = r.members || [];
  if (!members.length) return '';
  const count = key => members.filter(m => m.setup?.[key]).length;
  return panel('Agent setup', bars([{name: 'Signed in to the CLI', count: count('cli')}, {name: 'Connected MCP', count: count('mcp')}, {name: 'Sending sessions', count: count('session')}], {total: members.length}), {note: `Out of ${plural(members.length, 'member')}.`});
}

function team(r, now) {
  const members = r.members || [];
  if (!members.length) return empty('Team reporting isn’t available on this deployment.');
  const active = members.filter(m => m.weekEvents).length;
  const ready = members.filter(m => m.setup?.cli && m.setup?.mcp && m.setup?.session).length;
  const sources = members.reduce((sum, m) => sum + (m.sources || 0), 0);
  const top = key => members.filter(m => m[key]).sort((a, b) => b[key] - a[key])[0];
  const name = m => m.name || m.email;
  const integrator = top('sources'), user = top('sessions'), builder = top('toolCalls');
  const highlight = (label, m, value) => m ? `<div class="highlight"><dt>${escape(label)}</dt><dd><strong>${escape(name(m))}</strong><span>${value}</span></dd></div>` : '';
  const dots = s => ['cli', 'mcp', 'session'].map(k => `<span class="dot${s?.[k] ? ' on' : ''}" title="${({cli: 'CLI', mcp: 'MCP', session: 'Sessions'})[k]}${s?.[k] ? ' set up' : ' not set up'}"></span>`).join('');
  const rows = [...members].sort((a, b) => (b.sessions - a.sessions) || (b.sources - a.sources) || name(a).localeCompare(name(b))).map(m => `<tr><th scope="row"><span class="member">${escape(name(m))}${m.you ? ' <em>you</em>' : ''}</span>${m.name ? `<span class="email">${escape(m.email)}</span>` : ''}</th><td><span class="dots">${dots(m.setup)}</span>${m.setup?.client ? `<span class="email">${escape(m.setup.client)}</span>` : ''}</td><td>${full(m.sources)}</td><td>${full(m.sessions)}</td><td>${full(m.toolCalls)}</td><td>${escape(m.lastAt ? ago(m.lastAt, now) : 'not yet')}</td></tr>`).join('');
  return `<p class="summary"><strong>${active} of ${plural(members.length, 'member')}</strong> used OpenCrawl this week${integrator ? `. ${escape(name(integrator))} has connected the most sources` : ''}${user ? `, and ${escape(name(user))} runs the most agent sessions` : ''}.</p>
${kpis([
    kpi('Members', full(members.length), r.workspace ? escape(r.workspace) : ''),
    kpi('Active this week', full(active), `${Math.round(active / members.length * 100)}% of the team`),
    kpi('Fully set up', full(ready), 'CLI, MCP and sessions'),
    kpi('Sources connected', full(sources), 'by the team'),
  ])}
${integrator || user || builder ? `<dl class="highlights">${highlight('Top integrator', integrator, integrator && plural(integrator.sources, 'source'))}${highlight('Most active', user, user && plural(user.sessions, 'session'))}${highlight('Most agent work', builder, builder && `${full(builder.toolCalls)} tool calls`)}</dl>` : ''}
${panel('Members', `<div class="table"><table><thead><tr><th scope="col">Member</th><th scope="col">Setup</th><th scope="col">Sources</th><th scope="col">Sessions</th><th scope="col">Tool calls</th><th scope="col">Last active</th></tr></thead><tbody>${rows}</tbody></table></div>`, {wide: true, note: 'Setup dots: CLI, MCP, sessions.'})}`;
}

/** report: {tab, workspace, team, days, ingestion, agents, members, integrationsUrl, generatedAt}. */
export function renderUsage(report, {path = '/usage', now = Date.now()} = {}) {
  const tab = TABS.some(([id]) => id === report.tab) ? report.tab : 'ingestion';
  const nav = TABS.map(([id, label]) => `<a href="${escape(path)}?tab=${id}"${id === tab ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const body = {ingestion, agents, team}[tab](report, now);
  const scope = [report.workspace, report.days ? `last ${report.days} days` : '', `updated ${ago(report.generatedAt || new Date(now).toISOString(), now)}`].filter(Boolean).map(escape).join(' · ');
  return `<main class="usage"><div class="usage-head"><div><h1>Usage and reporting</h1><p>${scope}</p></div><nav class="tabs" aria-label="Report">${nav}</nav></div>${body}</main>`;
}
