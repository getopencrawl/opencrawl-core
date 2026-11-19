import {useEffect, useId, useRef, useState} from 'react';
import {Button, Field, Input, LoadingState, Notice, Section, Textarea} from '../design/components.js';
import type {LibraryAdapter, LibraryContract} from './library-types.js';
import {failureMessage, useResource} from './use-resource.js';

type Preference = LibraryContract['privacy/status']['output'];

export function PrivacySettings({adapter}: {adapter: LibraryAdapter}) {
  const state = useResource(adapter, 'privacy/status', '', 0, signal => adapter('privacy/status', {}, signal), 'Could not load privacy settings.');
  const preference = state.data;
  const descriptionId = useId();

  return <Section className="oc-management-panel" title="Session privacy" description={
    <span id={descriptionId}>Only you can see a private session. Use this setting to hide conversations about your personal life or work discussions meant for a limited audience.</span>
  }>
    {!preference && !state.error && <LoadingState label="Loading privacy settings"/>}
    {!preference && state.error && <div className="stack-sm oc-form-measure">
      <Notice tone="danger">{state.error}</Notice>
      <div><Button onClick={state.retry}>Retry</Button></div>
    </div>}
    {preference && <PrivacyForm key={preference.subject} initial={preference} adapter={adapter} descriptionId={descriptionId} saved={next => state.replace(() => next)}/>}
  </Section>;
}

function PrivacyForm({initial, adapter, descriptionId, saved}: {
  initial: Preference;
  adapter: LibraryAdapter;
  descriptionId: string;
  saved: (next: Preference) => void;
}) {
  const [draft, setDraft] = useState<Preference | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const checkbox = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const lastChanged = useRef<'enabled' | 'rules'>('enabled');
  const value = draft ?? initial;
  const changed = value.enabled !== initial.enabled || value.rules !== initial.rules;

  useEffect(() => () => pending.current?.abort(), []);

  function finishEditing() {
    setDraft(null);
    setError('');
    requestAnimationFrame(() => {
      const control = lastChanged.current === 'rules' ? textarea.current : checkbox.current;
      control?.focus({preventScroll: true});
    });
  }

  async function save() {
    if (!changed || !draft || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      const next = await adapter('privacy/change', draft, request.signal);
      if (!request.signal.aborted) {
        saved(next);
        finishEditing();
      }
    } catch (failure) {
      if (!request.signal.aborted) setError(failureMessage(failure, 'Could not save privacy settings.'));
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return <form className="stack oc-form-measure" onSubmit={event => {event.preventDefault(); void save();}}>
    <label className="oc-choice-label">
      <Input ref={checkbox} type="checkbox" checked={value.enabled} disabled={busy} aria-describedby={descriptionId} onChange={event => {
        lastChanged.current = 'enabled';
        setError('');
        setDraft({...value, enabled: event.target.checked});
      }}/>
      Automatically hide sensitive or personal sessions from your team
    </label>
    <Field label={<>Custom privacy rules <span className="muted">(optional)</span></>} hint={value.enabled ? undefined : 'Rules apply when automatic hiding is on.'}>
      <Textarea ref={textarea} rows={3} maxLength={1500} value={value.rules} disabled={busy}
        placeholder="Describe any other topics you’d like to keep private." onChange={event => {
          lastChanged.current = 'rules';
          setError('');
          setDraft({...value, rules: event.target.value});
        }}/>
    </Field>
    {error && <Notice tone="danger">{error}</Notice>}
    {changed && <div className="actions oc-preference-actions">
      <Button variant="quiet" disabled={busy} onClick={finishEditing}>Discard changes</Button>
      <Button type="submit" variant="primary" busy={busy}>Save changes</Button>
    </div>}
  </form>;
}
