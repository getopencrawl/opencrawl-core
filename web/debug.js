/** Presentation only: authorization and retrieval remain in the search adapters. */
export function resultLabel(source, family) {
  if (family === 'connector') {
    const provider = source.provider === 'slack' ? 'Slack' : source.provider || 'Connected source';
    const reply = source.threadTs && source.timestamp && source.threadTs !== source.timestamp;
    return provider + (source.kind === 'message' ? (reply ? ' reply' : ' message') : ' item');
  }
  const harness = {'claude-code': 'Claude Code', codex: 'Codex'}[source.harness] || 'Agent session';
  let kind = 'Session event';
  if (source.toolNames?.length || source.kind === 'tool_call') kind = 'Tool call';
  else if (source.role === 'tool' || /tool_result|function_call_output|custom_tool_call_output/.test(source.kind || '')) kind = 'Tool result';
  else if (source.role === 'user') kind = 'User message';
  else if (source.role === 'assistant') kind = 'Assistant message';
  else if (source.role === 'system' || source.role === 'developer') kind = 'Instructions';
  else kind = {compaction: 'Conversation summary', reasoning_summary: 'Reasoning summary', attachment: 'Attachment record', turn_metadata: 'Turn metadata', session_metadata: 'Session metadata', hook: 'Hook event'}[source.kind] || 'Session event';
  return harness + ' · ' + kind;
}

export function resultGroups(data) {
  const groups = [];
  if (data.connectors) groups.push({label: 'Connected sources', hits: (data.connectors.responses || []).flatMap(r => r.hits?.hits || []), family: 'connector', state: data.connectors.state, truncated: data.connectors.truncated});
  for (const session of data.sessions || []) groups.push({label: session.scope === 'personal' ? 'Personal agent sessions' : 'Workspace agent sessions', hits: session.response?.hits?.hits || [], family: 'session', total: session.response?.hits?.total?.value, state: session.response?.state});
  return groups;
}

export function queryPattern(query) {
  const terms = [...new Set(query.match(/[\p{L}\p{N}_]+/gu) || [])].sort((a, b) => b.length - a.length);
  return terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu') : null;
}

export function excerpt(text, query, limit = 700) {
  const pattern = queryPattern(query), match = pattern?.exec(text);
  const start = text.length > limit && match ? Math.max(0, match.index - 140) : 0;
  const end = Math.min(text.length, start + limit);
  return {text: text.slice(start, end), leading: start > 0, trailing: end < text.length};
}

export function resultTime(source, family) {
  const value = family === 'connector' && /^\d+\.\d+$/.test(source.timestamp || '') ? Number(source.timestamp) * 1000 : source.timestamp || source.receivedAt;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function highlightedText(node, text, query) {
  const pattern = queryPattern(query);
  if (!pattern) {node.textContent = text; return;}
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    node.append(document.createTextNode(text.slice(from, match.index)), element('mark', '', match[0]));
    from = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(from)));
}
function disclosure(label, content) {
  const details = element('details', 'debug-disclosure');
  details.append(element('summary', '', label), content);
  return details;
}
function jsonView(value, label) {
  const pre = element('pre', 'debug-json', JSON.stringify(value, null, 2));
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', label);
  return pre;
}
function renderGroups(container, groups, query) {
  for (const group of groups) {
    if (!group.hits.length) continue;
    const section = element('section', 'debug-group');
    section.append(element('h2', '', `${group.label} · ${group.hits.length}${group.total > group.hits.length ? ' of ' + group.total : ''}`));
    for (const hit of group.hits) {
      const source = hit._source || {}, label = resultLabel(source, group.family);
      const article = element('article', 'debug-hit');
      article.append(element('h3', '', label));
      const meta = element('p', 'debug-meta');
      const date = resultTime(source, group.family);
      if (date) {
        const time = element('time', '', date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}));
        time.dateTime = date.toISOString(); meta.append(time);
      }
      const identifier = group.family === 'connector' ? source.channelId && 'Channel ' + source.channelId : source.sessionId && 'Session ' + source.sessionId;
      if (identifier) meta.append(element('span', '', identifier));
      if (source.toolNames?.length) meta.append(element('span', '', source.toolNames.join(', ')));
      if (meta.childNodes.length) article.append(meta);
      const text = typeof source.text === 'string' ? source.text : '';
      const preview = excerpt(text, query), body = element('p', 'debug-text');
      highlightedText(body, (preview.leading ? '…' : '') + preview.text + (preview.trailing ? '…' : ''), query);
      if (!text) body.textContent = 'No indexed text in this item.';
      article.append(body);
      if (preview.leading || preview.trailing) {
        const full = element('div', 'debug-text debug-full-text');
        full.tabIndex = 0;
        full.setAttribute('role', 'region');
        full.setAttribute('aria-label', 'Full indexed text');
        const details = disclosure('Full indexed text', full);
        details.addEventListener('toggle', () => {if (details.open && !full.childNodes.length) highlightedText(full, text, query);});
        article.append(details);
      }
      article.append(disclosure('Item JSON', jsonView(hit, label + ' JSON')));
      section.append(article);
    }
    if (group.truncated) section.append(element('p', 'debug-meta', 'More matches may be available; narrow the query to see other items.'));
    container.append(section);
  }
}

if (typeof document !== 'undefined' && document.querySelector('#debug-search')) {
  const form = document.querySelector('#debug-search');
  const input = document.querySelector('#query');
  const button = form.querySelector('button');
  const status = document.querySelector('#debug-status');
  const results = document.querySelector('#debug-results');
  const list = document.querySelector('#debug-items');
  const raw = document.querySelector('#debug-raw');
  const rawBody = document.querySelector('#debug-raw-body');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query || button.disabled) return;
    button.disabled = true;
    button.textContent = 'Searching…';
    status.textContent = 'Searching…';
    status.classList.remove('debug-error');
    results.hidden = true;
    list.replaceChildren(); rawBody.textContent = ''; raw.open = false;
    results.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/debug/search', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query}), signal: AbortSignal.timeout(60000)});
      if (response.status === 401) throw new Error('Your session expired. Sign in again, then retry.');
      if (!response.ok) throw new Error(response.status === 403 ? 'Workspace access could not be verified. Sign in again, then retry.' : 'Search failed. Please try again.');
      const data = await response.json(), groups = resultGroups(data);
      const count = groups.reduce((n, group) => n + group.hits.length, 0);
      rawBody.textContent = JSON.stringify(data, null, 2);
      renderGroups(list, groups, query);
      results.hidden = false;
      status.textContent = count ? `${count} matching ${count === 1 ? 'item' : 'items'} shown. Query words are highlighted.` : 'No matching items. Try another query.';
      const pending = groups.filter(g => g.state === 'pending').map(g => g.label);
      const unavailable = groups.filter(g => g.state === 'not_configured').map(g => g.label);
      if (pending.length) status.textContent += ` ${pending.join(', ')}: indexing pending.`;
      if (unavailable.length) status.textContent += ` ${unavailable.join(', ')}: not configured.`;
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' ? 'Search timed out. Please try again.' : error.message;
      status.classList.add('debug-error');
    } finally {
      button.disabled = false;
      button.textContent = 'Search';
      results.setAttribute('aria-busy', 'false');
    }
  });
}

if (typeof document !== 'undefined' && document.querySelector('#debug-board')) {
  const form = document.querySelector('#debug-board');
  const topic = document.querySelector('#board-topic');
  const refresh = form.querySelector('button');
  const status = document.querySelector('#board-status');
  const list = document.querySelector('#board-messages');
  const older = document.querySelector('#board-more');
  let next = null, busy = false;
  async function load(append = false) {
    if (busy) return;
    busy = true;
    refresh.disabled = topic.disabled = older.disabled = true;
    status.textContent = 'Loading messages…';
    status.classList.remove('debug-error');
    list.setAttribute('aria-busy', 'true');
    if (!append) {list.replaceChildren(); next = null; older.hidden = true;}
    const query = new URLSearchParams();
    if (topic.value) query.set('topic', topic.value);
    if (append && next !== null) query.set('before', String(next));
    try {
      const response = await fetch('/api/debug/board?' + query, {signal: AbortSignal.timeout(30000)});
      if (response.status === 401) throw new Error('Your session expired. Sign in again, then retry.');
      if (response.status === 403) throw new Error('Workspace admin access could not be verified. Sign in again, then retry.');
      if (!response.ok) throw new Error('Could not load messages. Please refresh to try again.');
      const data = await response.json();
      const selected = topic.value;
      topic.replaceChildren(new Option('All topics', ''), ...data.topics.map(name => new Option(name, name)));
      topic.value = selected;
      for (const message of data.messages) {
        const article = element('article', 'debug-hit');
        article.append(element('h3', '', message.topic));
        const meta = element('p', 'debug-meta');
        meta.append(element('span', '', message.name || message.agent));
        const date = new Date(message.timestamp);
        if (Number.isFinite(date.getTime())) {
          const time = element('time', '', date.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}));
          time.dateTime = date.toISOString(); meta.append(time);
        }
        meta.append(element('span', '', '#' + message.id));
        article.append(meta, element('p', 'debug-text', message.text));
        list.append(article);
      }
      next = data.next;
      older.hidden = next === null;
      const count = list.childElementCount;
      status.textContent = count ? `${count} ${count === 1 ? 'message' : 'messages'} shown${next !== null ? '. Older messages available.' : '.'}` : 'No messages in this topic yet.';
      if (!count && !topic.value) status.textContent = 'No workspace messages yet.';
    } catch (error) {
      // Do not leave previously loaded workspace data visible after a failed access check.
      list.replaceChildren(); next = null; older.hidden = true;
      status.textContent = error.name === 'TimeoutError' ? 'Loading timed out. Please refresh to try again.' : error.message;
      status.classList.add('debug-error');
    } finally {
      busy = false;
      refresh.disabled = topic.disabled = older.disabled = false;
      list.setAttribute('aria-busy', 'false');
    }
  }
  form.addEventListener('submit', event => {event.preventDefault(); load();});
  topic.addEventListener('change', () => load());
  older.addEventListener('click', () => load(true));
  load();
}
