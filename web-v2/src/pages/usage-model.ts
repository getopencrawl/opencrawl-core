import type {UsageReport} from './types.ts';

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
  return ({'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'grok-bot': 'Grok Bot', antigravity: 'Antigravity'} as Record<string, string>)[name] || name;
}

