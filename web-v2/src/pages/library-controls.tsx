import {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {Button, Dialog, Notice, StatusBadge} from '../design/components.js';
import {Icon} from '../design/icons.js';
import {ago} from './usage-model.js';
import type {Authors, Visibility} from './library-types.js';
import {failureMessage} from './use-resource.js';

export function authorName(userId: string, mine: boolean, authors?: Authors['authors']) {
  return mine ? 'You' : authors?.[userId] || userId;
}
export function harnessName(harness: string) {
  return harness === 'claude-code' ? 'Claude Code' : harness === 'codex' ? 'Codex' : harness;
}
export function VisibilityBadge({value}: {value: boolean}) {
  return value ? <StatusBadge tone="warning">Private</StatusBadge> : null;
}
export function When({value, prefix = ''}: {value: string | null; prefix?: string}) {
  return value ? <time dateTime={value} title={new Date(value).toLocaleString()}>{prefix}{ago(value)}</time> : null;
}
/** Groups newest-first rows under Today, Yesterday or a calendar date. */
export function byDay<T>(items: ReadonlyArray<T>, at: (item: T) => string | null, now = new Date()): Array<[string, T[]]> {
  const day = (value: Date) => value.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
  const today = day(now), yesterday = day(new Date(now.getTime() - 86400000));
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = at(item), date = value ? day(new Date(value)) : '';
    const label = !value ? 'Unknown date' : date === today ? 'Today' : date === yesterday ? 'Yesterday' : date;
    groups.set(label, [...groups.get(label) ?? [], item]);
  }
  return [...groups];
}
/** Metadata as separate, labelled items; never joined with separator glyphs. */
export function MetaList({items}: {items: ReadonlyArray<{label: string; value: ReactNode}>}) {
  return <dl className="oc-library-meta">{items.filter(item => item.value !== null && item.value !== '').map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}

/** Owner-only actions. The server repeats every ownership check. */
export function OwnerControls({noun, visibility, onVisibility, onDelete, deleteDescription}: {
  noun: 'session' | 'memory'; visibility: Visibility;
  onVisibility: (next: Visibility, signal: AbortSignal) => Promise<void>;
  onDelete: (signal: AbortSignal) => Promise<void>;
  deleteDescription: ReactNode;
}) {
  const [busy, setBusy] = useState<'' | 'visibility' | 'delete'>(''), [error, setError] = useState(''), [confirming, setConfirming] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(action: 'visibility' | 'delete', work: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(action); setError('');
    try {await work(current.signal); if (!current.signal.aborted && action === 'delete') setConfirming(false);}
    catch (failure) {if (!current.signal.aborted) setError(failureMessage(failure, `The ${noun} could not be updated. Try again.`));}
    finally {if (!current.signal.aborted) setBusy('');}
  }
  const next: Visibility = visibility === 'private' ? 'team' : 'private';
  return <div className="oc-library-controls">
    <div className="actions">
      <Button busy={busy === 'visibility'} disabled={Boolean(busy)} onClick={() => void run('visibility', signal => onVisibility(next, signal))}>{visibility === 'private' ? 'Share with team' : 'Make private'}</Button>
      <Button variant="danger" disabled={Boolean(busy)} onClick={() => {setError(''); setConfirming(true);}}><Icon name="trash"/>Delete {noun}</Button>
    </div>
    {error && !confirming && <Notice tone="danger">{error}</Notice>}
    <Dialog open={confirming} onClose={() => {if (busy !== 'delete') setConfirming(false);}} title={`Delete this ${noun}?`} description={deleteDescription}
      actions={<><Button disabled={busy === 'delete'} onClick={() => setConfirming(false)}>Cancel</Button><Button variant="danger" busy={busy === 'delete'} onClick={() => void run('delete', onDelete)}>Delete {noun}</Button></>}>
      {error ? <Notice tone="danger">{error}</Notice> : <p className="muted">This cannot be undone.</p>}
    </Dialog>
  </div>;
}
