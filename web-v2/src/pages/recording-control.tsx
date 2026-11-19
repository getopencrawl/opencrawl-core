import {useEffect, useRef, useState} from 'react';
import {Button, Dialog, LoadingState, Notice, Section} from '../design/components.js';
import {Icon} from '../design/icons.js';
import type {LibraryAdapter, LibraryContract} from './library-types.js';
import {failureMessage, useResource} from './use-resource.js';

export function RecordingSettings({adapter}: {adapter: LibraryAdapter}) {
  const state = useResource(adapter, 'recording/status', '', 0, signal => adapter('recording/status', {}, signal), 'Recording status unavailable.');
  const status = state.data && 'paused' in state.data ? state.data : null;
  const [selection, setSelection] = useState<typeof status>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reload = useRef(state.retry);
  reload.current = state.retry;
  useEffect(() => () => pending.current?.abort(), [adapter]);
  useEffect(() => {
    if (!status?.paused || status.until == null) return;
    const timer = window.setTimeout(() => reload.current(), Math.max(0, status.until - Date.now()) + 100);
    return () => window.clearTimeout(timer);
  }, [status?.revision, status?.paused, status?.until]);

  async function change(mode: LibraryContract['recording/change']['input']['mode']) {
    const shown = mode === 'resume' ? status : selection;
    if (!shown || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      const next = await adapter('recording/change', {mode, revision: shown.revision, subject: shown.subject}, request.signal);
      if (!request.signal.aborted) state.replace(() => next);
    } catch (failure) {
      if (!request.signal.aborted) {
        setError(failureMessage(failure, 'Could not update recording. Try again.'));
        state.retry();
      }
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
        setSelection(null);
        requestAnimationFrame(() => trigger.current?.focus({preventScroll: true}));
      }
    }
  }

  return <Section className="oc-management-panel" title="Session recording" description="Pausing excludes new activity from your agents in this workspace.">
    <div className="stack-sm">
      {status ? <>
        <div className="split oc-preference-row">
          <div className="oc-preference-status" role="status" aria-atomic="true">
            <span aria-hidden="true" className={'oc-preference-dot' + (status.paused ? ' paused' : '')}/>
            <div><strong>{status.paused ? 'Recording is paused' : 'Recording is on'}</strong>
              {status.paused && <p>{status.until == null ? 'Until you resume recording.' : <>Resumes at <time dateTime={new Date(status.until).toISOString()}>{new Date(status.until).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}</time>.</>}</p>}
            </div>
          </div>
          <Button ref={trigger} busy={busy} aria-haspopup={status.paused ? undefined : 'dialog'}
            onClick={() => status.paused ? void change('resume') : setSelection(status)}>
            {status.paused ? 'Resume recording' : 'Pause recording'}
          </Button>
        </div>
        <Dialog className="oc-preference-dialog" open={Boolean(selection) && !status.paused} title="Pause recording"
          description="How long would you like to pause?" onClose={() => {if (!pending.current) setSelection(null);}}>
          <div className="oc-preference-options">
            <Button variant="quiet" disabled={busy} onClick={() => void change('hour')}><Icon name="clock" size={18}/>For 1 hour<Icon name="chevron-right" size={14}/></Button>
            <Button variant="quiet" disabled={busy} onClick={() => void change('indefinite')}><Icon name="infinity" size={18}/>Until I turn it back on<Icon name="chevron-right" size={14}/></Button>
          </div>
        </Dialog>
      </> : state.data && 'available' in state.data ? <p className="muted">Recording controls are unavailable in this workspace.</p>
        : state.error ? <div className="stack-sm oc-form-measure"><Notice tone="danger">{state.error}</Notice><div><Button onClick={state.retry}>Try again</Button></div></div>
        : <LoadingState label="Checking recording status"/>}
      {error && <Notice tone="danger" className="oc-form-measure">{error}</Notice>}
    </div>
  </Section>;
}
