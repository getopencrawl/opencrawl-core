import {consoleResourceKey} from '../data.tsx';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Button, Input} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {useNavigate} from '../router.tsx';
import {normalizeInvitationEmail, safeWorkspacePath} from './model.ts';
import {useOnboardingResource} from './resource.ts';
import {OnboardingShell} from './shell.tsx';
import type {InvitationList, OnboardingAdapter} from './types.ts';

export interface InviteOnboardingProps {
  adapter: OnboardingAdapter;
  canInvite: boolean;
  initialInvitations?: InvitationList;
  /** Refresh the application's authoritative admission state after finishing. */
  onComplete?: (workspaceUrl: string) => void | Promise<void>;
}

export function InviteOnboarding({adapter, canInvite, initialInvitations, onComplete}: InviteOnboardingProps) {
  const invitations = useOnboardingResource(signal => adapter.invitations(signal), {key:consoleResourceKey(adapter,'onboarding-invitations'), enabled: canInvite, initial: initialInvitations});
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const finishOperation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const navigate = useNavigate();
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; operation.current?.abort(); finishOperation.current?.abort();};}, []);
  async function invite(event: FormEvent) {
    event.preventDefault();
    if (operation.current || finishing) return;
    const normalized = normalizeInvitationEmail(email);
    if (!normalized || !field.current?.validity.valid) {setError('Enter one valid email address, like teammate@company.com.'); field.current?.focus(); return;}
    const controller = new AbortController();
    operation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setBusy(true); setError(null); setFeedback(null);
    try {
      const result = await adapter.invite(normalized, controller.signal);
      if (!mounted.current) return;
      invitations.replace(result); setEmail(''); setFeedback(result.addedCount === 0 ? 'This teammate is already on the list.' : 'Invitation sent.');
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'The invitation could not be sent. Try again.');
    } finally {
      clearTimeout(timeout); operation.current = null;
      if (mounted.current) {setBusy(false); requestAnimationFrame(() => field.current?.focus());}
    }
  }
  async function finish() {
    if (finishOperation.current || operation.current) return;
    const controller = new AbortController();
    finishOperation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    setFinishing(true); setFinishError(null);
    try {
      const result = await adapter.finish(controller.signal);
      if (!mounted.current) return;
      const path = safeWorkspacePath(result.workspaceUrl);
      if (onComplete) await onComplete(path);
      else navigate(path);
    } catch (failure) {
      if (mounted.current) setFinishError(failure instanceof Error ? failure.message : 'We couldn’t finish setup. Try again.');
    } finally {
      clearTimeout(timeout); finishOperation.current = null;
      if (mounted.current) setFinishing(false);
    }
  }
  const items = invitations.data?.items ?? [];
  return <OnboardingShell step="invite" backUrl="/onboarding/sources" nextVisible nextLabel={items.length ? 'Open workspace' : 'Skip for now'} nextPrimary={items.length > 0} busy={finishing || busy} onNext={() => void finish()}>
    <section aria-labelledby="invite-title"><h1 id="invite-title" tabIndex={-1}>Invite your teammates</h1><p className="focus-description">Share this workspace with your team. You can also invite them later.</p>
      {canInvite ? <>
        <div className="invite-editor">
          {items.length > 0 && <ul className="invitation-list" aria-label="Invitations">{items.map(invitation => <li key={invitation.email}><Icon name="check" className="signal-mark" /><span className="invitation-email">{invitation.email}</span></li>)}</ul>}
          <form className="invite-form" noValidate onSubmit={event => void invite(event)}><label htmlFor="invite-emails" className="sr-only">Email address</label><div className="invite-entry"><Input ref={field} id="invite-emails" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} placeholder="teammate@company.com" aria-describedby={error ? 'invite-error' : undefined} aria-invalid={error ? true : undefined} value={email} onChange={event => {setEmail(event.target.value); setError(null); setFeedback(null);}} required disabled={busy || finishing} /><Button variant="primary" type="submit" disabled={busy || finishing || !email.trim()}>{busy ? 'Inviting…' : 'Invite'}</Button></div>{error && <p id="invite-error" className="invite-error" role="alert">{error}</p>}</form>
          {feedback && <p className={`invite-feedback${feedback === 'Invitation sent.' ? ' sr-only' : ''}`} role="status">{feedback}</p>}
        </div>
        {invitations.error && <div className="invite-load-error"><p role="alert">We couldn’t load existing invitations.</p><Button variant="quiet" onClick={invitations.reload}>Try again</Button></div>}
      </> : <p className="focus-description">Your workspace admin can invite teammates. You can continue now.</p>}
      {finishError && <p className="invite-error" role="alert">{finishError}</p>}
    </section>
  </OnboardingShell>;
}
