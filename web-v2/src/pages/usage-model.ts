import type {ModelPrice, UsageReport, ValueReport} from './types.ts';

export type UsageSource = NonNullable<UsageReport['ingestion']>['sources'][number];
export type UsageMember = UsageReport['members'][number];

export function measured(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function count(value: number | null | undefined) {
  return measured(value) ? value.toLocaleString('en-US') : 'Unavailable';
}

export function compact(value: number | null | undefined) {
  if (!measured(value)) return 'Unavailable';
  if (value < 10000) return count(value);
  const [divisor, suffix] = value >= 1e9 ? [1e9, 'B'] : value >= 1e6 ? [1e6, 'M'] : [1e3, 'k'];
  return (value / divisor).toFixed(value / divisor >= 100 ? 0 : 1).replace(/\.0$/, '') + suffix;
}

export function plural(value: number, one: string, many = one + 's') {
  return `${count(value)} ${value === 1 ? one : many}`;
}

export function ago(value: string | null | undefined, now = Date.now()) {
  if (!value) return 'never';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'never';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const [amount, unit] = seconds < 3600 ? [Math.round(seconds / 60), 'minute']
    : seconds < 86400 ? [Math.round(seconds / 3600), 'hour'] : [Math.round(seconds / 86400), 'day'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'} ago`;
}

export function sourceStatus(state: string): {label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'} {
  const states = {
    synced: {label: 'Synced', tone: 'success'},
    syncing: {label: 'Syncing', tone: 'warning'},
    error: {label: 'Needs attention', tone: 'danger'},
    connecting: {label: 'Connecting', tone: 'warning'},
    unavailable: {label: 'Status unavailable', tone: 'danger'},
  } as const;
  return state in states ? states[state as keyof typeof states] : {label: state, tone: 'neutral'};
}

/** Species describe indexed documents; importer progress rows are a separate measurement. */
export function speciesLabel(name: string) {
  const labels: Record<string, string> = {
    message: 'Messages', channel: 'Channels', file: 'Files', page: 'Pages', database: 'Databases', database_row: 'Database rows',
    comment: 'Comments', commit: 'Commits', issue: 'Issues', issue_comment: 'Issue comments',
    pull_request: 'Pull requests', pull_request_comment: 'Pull request comments', pull_request_review: 'Pull request reviews',
    pull_request_review_comment: 'Review comments', discussion: 'Discussions', discussion_comment: 'Discussion comments',
    repository: 'Repositories', branch: 'Branches', release: 'Releases',
    meeting: 'Meetings', transcript: 'Transcripts', summary: 'Summaries', calendar_event: 'Calendar events',
  };
  if (labels[name]) return labels[name];
  const words = name.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Other content';
}

export const memberName = (member: UsageMember) => member.name || member.email;
const rankValue = (value: number) => measured(value) ? value : -1;

/** The displayed ordering uses measured sessions, then tool calls; it is not a synthetic score. */
export function sortedMembers(members: UsageMember[]) {
  return [...members].sort((left, right) => rankValue(right.sessions) - rankValue(left.sessions)
    || rankValue(right.toolCalls) - rankValue(left.toolCalls)
    || memberName(left).localeCompare(memberName(right)));
}

export function topMember(members: UsageMember[], key: 'sources' | 'sessions' | 'toolCalls') {
  return members.filter(member => measured(member[key]) && member[key] > 0)
    .sort((left, right) => right[key] - left[key] || memberName(left).localeCompare(memberName(right)))[0];
}

export function harnessName(name: string) {
  return ({'claude-code': 'Claude Code', codex: 'Codex'} as Record<string, string>)[name] || name;
}

export function originName(name: string) {
  return ({cli: 'Terminal', desktop: 'Desktop app', cloud: 'Cloud', subagent: 'Subagents', unknown: 'Other'} as Record<string, string>)[name] || name;
}

/** List-price value, in dollars, of the tokens a value report credits as saved. */
export function pricedSavings(saved: ValueReport['savings']['tokens'], price: ModelPrice) {
  return (saved.input * price.input + saved.cacheRead * price.cacheRead + saved.cacheWrite * price.cacheWrite + saved.output * price.output) / 1e6;
}

export function savedTokens(saved: ValueReport['savings']['tokens']) {
  return saved.input + saved.cacheRead + saved.cacheWrite + saved.output;
}

export function dollars(value: number) {
  return value.toLocaleString('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: value < 100 ? 2 : 0});
}
