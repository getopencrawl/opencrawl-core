import type {SourceCard} from './types.mjs';

export const sourceBusy = (source: SourceCard): boolean => ['connecting', 'syncing'].includes(source.state);
export const sourceDeletable = (source: SourceCard): boolean => ['syncing', 'synced', 'connected', 'error'].includes(source.state) && source.recoveryAction !== 'connect';

export function disconnectDescription(source: SourceCard): string {
  return `OpenCrawl will stop syncing ${source.name}${source.scope === 'team' ? ' for your whole team' : ''} and permanently delete everything imported from it. This can’t be undone.`;
}

export function sourceStatus(source: SourceCard): {label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'} {
  if (source.statusUnavailable) return {label:'Status unavailable',tone:'warning'};
  switch (source.state) {
    case 'synced': case 'connected': return {label: 'Connected', tone: 'success'};
    case 'syncing': return {label: 'Importing', tone: 'warning'};
    case 'connecting': return {label: 'Awaiting sign-in', tone: 'warning'};
    case 'error': return {label: 'Needs attention', tone: 'danger'};
    case 'unavailable': return {label: 'Unavailable', tone: 'neutral'};
    case 'setup-required': return {label: 'Setup required', tone: 'neutral'};
    case 'disconnected': return {label: 'Not connected', tone: 'neutral'};
  }
}

export function sourceProgress(source: SourceCard): string {
  if (source.statusUnavailable) return source.synced !== undefined ? 'Sync status is temporarily unavailable. Showing the last measurement.' : 'Sync status is temporarily unavailable. We’ll check again automatically.';
  if (source.statusUpdatedAt === null && source.statusRefreshing) return 'Checking sync status…';
  if(source.state==='setup-required')return source.setup?.requirement ? `${source.setup.requirement}.` : 'Your instance administrator needs to configure this connection.';
  if (source.synced === undefined && ['synced','syncing','connected'].includes(source.state)) return 'Updating imported counts…';
  const count = Math.max(0, source.synced ?? 0);
  const units = source.units ?? ['item', 'items'];
  const countText = `${count.toLocaleString()} ${count === 1 ? units[0] : units[1]}`;
  if (source.finishing) return `${countText} imported. Finishing long messages.`;
  if (source.state === 'syncing' && source.initial !== false && source.total) return `${Math.min(count, source.total).toLocaleString()} of ${source.total.toLocaleString()} ${units[1]} imported${source.eta && source.eta > 0 ? `. ${remaining(source.eta)}` : ''}`;
  if (source.state === 'syncing') return count ? `${countText} imported so far` : 'Preparing your import…';
  if (source.state === 'connecting') return 'Finish signing in using the window that opened.';
  if (source.state === 'error') return source.message || (source.recoveryAction === 'disconnect' ? 'Removal did not finish. Retry to finish deleting imported data.' : 'This source needs attention. Try syncing again.');
  if (source.state === 'unavailable') return 'Connection status is temporarily unavailable. We’ll check again automatically.';
  return countText;
}

export function remaining(seconds: number): string {
  if (seconds < 60) return 'Less than a minute left';
  if (seconds < 3600) {const minutes = Math.round(seconds / 60); return `About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left`;}
  const hours = Math.round(seconds / 360) / 10;
  return `About ${hours} ${hours === 1 ? 'hour' : 'hours'} left`;
}
