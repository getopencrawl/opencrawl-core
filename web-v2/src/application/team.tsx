import {useEffect, useId, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {Button, CopyField, Dialog, EmptyState, Input, LoadingState, Notice, Page, Section, Select, StatusBadge} from '../index.ts';
import {ConsoleApiError, failureMessage} from './errors.ts';
import type {WorkspaceRole, TeamAdapter} from './api.ts';
import {useResource} from './resource';

type TeamMutation = {kind: 'invite'} | {kind: 'role'; userId: string; role: WorkspaceRole} | {kind: 'remove'; userId: string} | {kind: 'organization'};

function initials(name: string | null, email: string): string {
  const words = name && name !== email ? name.trim().split(/\s+/).filter(Boolean) : [];
  return words.length ? [words[0], ...(words.length > 1 ? [words[words.length - 1]] : [])].map(word => Array.from(word ?? '')[0] ?? '').join('').toUpperCase() : (Array.from(email)[0] ?? '').toUpperCase();
}

function TeamFrame({organizationName, children}: {organizationName?: string; children: ReactNode}) {
  return <Page className="oc-management-page" title="Team" description={organizationName ? `People and access for ${organizationName}.` : 'People and access for your workspace.'}>{children}</Page>;
}
function TeamRosterLoading({children}: {children?: ReactNode}) {
  return <Section className="oc-management-panel" title="Members">{children ?? <LoadingState label="Loading team" />}</Section>;
}
export function TeamLoadingPage({children}: {children?: ReactNode}) {
  return <TeamFrame><TeamRosterLoading>{children}</TeamRosterLoading></TeamFrame>;
}

export function TeamPage({adapter, onWorkspaceRenamed, footer}: {adapter: TeamAdapter; onWorkspaceRenamed?: (name: string) => void; footer?: ReactNode}) {
  const [email, setEmail] = useState('');
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [organizationError, setOrganizationError] = useState('');
  const [organizationSuccess, setOrganizationSuccess] = useState('');
  const [pending, setPending] = useState<TeamMutation | null>(null);
  const [removing, setRemoving] = useState<{id: string; email: string} | null>(null);
  const [removalError, setRemovalError] = useState('');
  const {data, error, loading, reload, invalidate, updateData} = useResource(adapter.team, {autoRefreshMilliseconds: 30_000, paused: pending !== null});
  const [inviteError, setInviteError] = useState('');
  const [roleError, setRoleError] = useState<{userId: string; message: string} | null>(null);
  const [roleStatus, setRoleStatus] = useState('');
  const roleErrorId = useId();
  const [success, setSuccess] = useState('');
  const [createdInvite, setCreatedInvite] = useState<{email:string;url:string} | null>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const organizationInput = useRef<HTMLInputElement>(null);
  const roleInput = useRef<HTMLSelectElement | null>(null);
  const focusInvite = useRef(false);
  const focusOrganization = useRef(false);
  const mounted = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const memberEmails = new Set(data?.members?.map(member => member.email.trim().toLowerCase()));
  const invitationEmails = new Set<string>();
  const invitations = data?.role === 'admin' ? (data.invitations ?? []).filter(invitation => {
    const email = invitation.email.trim().toLowerCase();
    if (!email || (invitation.state && invitation.state !== 'pending') || memberEmails.has(email) || invitationEmails.has(email)) return false;
    invitationEmails.add(email);
    return true;
  }) : [];
  const counts = [data?.members && `${data.members.length} ${data.members.length === 1 ? 'member' : 'members'}`, invitations.length > 0 && `${invitations.length} pending`].filter(Boolean).join(', ');
  const nameValue = organizationName ?? data?.organization.name ?? '';
  const organizationErrorId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false; mutation.current?.abort(); mutation.current = null;};
  }, []);
  useEffect(() => {
    if (!pending && focusInvite.current) {
      focusInvite.current = false;
      emailInput.current?.focus();
    }
    if (!pending && focusOrganization.current) {
      focusOrganization.current = false;
      organizationInput.current?.focus();
    }
    if (!pending && roleInput.current) {
      if (roleInput.current.isConnected) roleInput.current.focus();
      roleInput.current = null;
    }
  }, [pending]);

  const current = (request: AbortController) => mounted.current && mutation.current === request && !request.signal.aborted;
  function begin(action: TeamMutation) {
    if (!mounted.current || !data || data.role !== 'admin' || mutation.current) return null;
    const request = new AbortController();
    mutation.current = request;
    setPending(action); setInviteError(''); setSuccess(''); setCreatedInvite(null); setRoleError(null); setRoleStatus('');
    setOrganizationError(''); setOrganizationSuccess('');
    return request;
  }
  function finish(request: AbortController) {
    if (!current(request)) return;
    mutation.current = null;
    setPending(null);
  }
  async function failed(failure: unknown, request: AbortController, roleMember?: {id: string; email: string}) {
    if (!current(request)) return;
    const message = failureMessage(failure);
    if (failure instanceof ConsoleApiError && [401, 402, 403].includes(failure.status)) {
      focusInvite.current = false;
      focusOrganization.current = false;
      setRemoving(null);
      invalidate(message);
      await reload();
    } else if (roleMember) {
      setRoleStatus('');
      setRoleError({userId: roleMember.id, message: `We couldn’t confirm the role change for ${roleMember.email}. ${message}`});
    } else {
      setInviteError(message);
      focusInvite.current = true;
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedEmail = email.trim().toLowerCase();
    const request = begin({kind: 'invite'});
    if (!request) return;
    try {
      const invitation = await adapter.invite(submittedEmail, request.signal);
      if (!current(request)) return;
      setSuccess(invitation.inviteUrl ? `Invitation created for ${submittedEmail}. Share the private link with them. No email was sent.` : `Invitation sent to ${submittedEmail}. They can join using the link in their email.`);
      if (invitation.inviteUrl) setCreatedInvite({email:submittedEmail,url:invitation.inviteUrl});
      setEmail('');
      focusInvite.current = true;
      // Automatic reads retry a failed refresh; never replay a successful invitation.
      await reload();
    } catch (failure) {await failed(failure, request);}
    finally {finish(request);}
  }

  async function changeRole(member: {id: string; email: string; role: WorkspaceRole}, input: HTMLSelectElement) {
    const value = input.value;
    if (!data?.viewerUserId || member.id === data.viewerUserId || (value !== 'admin' && value !== 'member') || value === member.role) return;
    const request = begin({kind: 'role', userId: member.id, role: value});
    if (!request) return;
    roleInput.current = input;
    setRoleStatus(`Updating the role for ${member.email}.`);
    try {
      const result = await adapter.changeRole(member.id, value, request.signal);
      if (!current(request)) return;
      if (!result.ok || result.userId !== member.id || result.role !== value) throw new Error('The server did not confirm this role change. The team will update automatically.');
      updateData(report => report.members ? {...report, members: report.members.map(item => item.id === member.id ? {...item, role: result.role} : item)} : report);
      setRoleStatus(`The role for ${member.email} is now ${result.role}.`);
      await reload();
    } catch (failure) {await failed(failure, request, member);}
    finally {finish(request);}
  }

  async function renameOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = nameValue.trim();
    if (!name || name === data?.organization.name) return;
    const request = begin({kind: 'organization'});
    if (!request) return;
    try {
      const result = await adapter.renameOrganization(name, request.signal);
      if (!current(request)) return;
      if (!result.ok || result.name !== name) throw new Error('The server did not confirm the organization name.');
      updateData(report => ({...report, organization: {...report.organization, name: result.name}}));
      onWorkspaceRenamed?.(result.name);
      setOrganizationName(null);
      setOrganizationSuccess('Organization name saved.');
      focusOrganization.current = true;
      await reload();
    } catch (failure) {
      if (!current(request)) return;
      if (failure instanceof ConsoleApiError && [401, 402, 403].includes(failure.status)) await failed(failure, request);
      else {
        setOrganizationError(`We couldn’t confirm the name change. ${failureMessage(failure)}`);
        focusOrganization.current = true;
      }
    } finally {finish(request);}
  }

  async function removeMember() {
    const member = removing;
    if (!member || member.id === data?.viewerUserId) return;
    const request = begin({kind: 'remove', userId: member.id});
    if (!request) return;
    setRemovalError('');
    try {
      const result = await adapter.removeMember(member.id, request.signal);
      if (!current(request)) return;
      if (!result.ok || result.userId !== member.id) throw new Error('The server did not confirm this removal.');
      updateData(report => ({...report, members: report.members?.filter(item => item.id !== member.id)}));
      setRemoving(null);
      setSuccess(`${member.email} was removed. Their workspace access has been revoked.`);
      focusInvite.current = true;
      await reload();
    } catch (failure) {
      if (!current(request)) return;
      if (failure instanceof ConsoleApiError && [401, 402, 403].includes(failure.status)) await failed(failure, request);
      else setRemovalError(`We couldn’t confirm the removal of ${member.email}. ${failureMessage(failure)}`);
    } finally {finish(request);}
  }

  return <TeamFrame organizationName={data?.organization.name}>
    {error && <Notice tone="danger">{data ? 'Team information couldn’t update. We’ll try again automatically while you’re viewing this page.' : error}</Notice>}
    {!data ? loading ? <TeamRosterLoading /> : <EmptyState title="Your team couldn’t load" action={<Button onClick={() => void reload()}>Try again</Button>} /> : <>
      <Section className="oc-management-panel" title={<>Members {counts && <span className="oc-member-count">{counts}</span>}</>}>
        {!data.members && <p className="muted">Member information is unavailable. We’ll try again automatically.</p>}
        {(data.members?.length ?? 0) + invitations.length > 0 ? <ul className="oc-member-list" aria-label="Workspace members">{data.members?.map(member => {
          const name = member.name && member.name !== member.email ? member.name : null;
          return <li className="oc-member-row" key={member.id} data-state="active">
            <span className="oc-member-avatar" aria-hidden="true">{initials(member.name, member.email)}</span>
            <div className="oc-member-identity"><span className="oc-member-name">{name || member.email}</span>{name && <span className="oc-member-email">{member.email}</span>}</div>
            {data.role === 'admin' && data.viewerUserId && member.id !== data.viewerUserId && !member.directoryManaged ? <Select
              className="oc-member-role"
              aria-label={`Role for ${member.email}`}
              aria-busy={(pending?.kind === 'role' && pending.userId === member.id) || undefined}
              aria-invalid={roleError?.userId === member.id || undefined}
              aria-describedby={roleError?.userId === member.id ? roleErrorId : undefined}
              disabled={pending !== null}
              value={pending?.kind === 'role' && pending.userId === member.id ? pending.role : member.role}
              onChange={event => void changeRole(member, event.currentTarget)}
            ><option value="admin">Admin</option><option value="member">Member</option></Select> : <span className="oc-member-role">{member.role === 'admin' ? 'Admin' : 'Member'}</span>}
            {data.role === 'admin' && data.viewerUserId && member.id !== data.viewerUserId && (member.directoryManaged
              ? <span className="muted">Managed by identity provider</span>
              : <Button variant="quiet" disabled={pending !== null} aria-label={`Remove ${member.email}`} onClick={() => {setRemoving({id:member.id,email:member.email}); setRemovalError('');}}>Remove</Button>)}
          </li>;
        })}{invitations.map(invitation => <li className="oc-member-row" key={`invitation:${invitation.email.trim().toLowerCase()}`} data-state="pending">
          <span className="oc-member-avatar" aria-hidden="true">{initials(null, invitation.email)}</span>
          <div className="oc-member-identity"><span className="oc-member-name oc-invitation-email">{invitation.email}</span>{invitation.inviteUrl && <CopyField label="Private invitation link" value={invitation.inviteUrl}/>}</div>
          <StatusBadge className="oc-member-role" tone="neutral" variant="pill">Pending</StatusBadge>
        </li>)}</ul> : data.members && <p className="muted">No members are listed yet.</p>}
        {roleError && <div id={roleErrorId}><Notice tone="danger">{roleError.message}</Notice></div>}
        <span className="sr-only" role="status">{roleStatus}</span>
        {data.role === 'admin' ? <>
          <form className="oc-invite-form" onSubmit={event => void invite(event)}>
            <div><h3>Invite teammates</h3><p>Invited teammates join as members, without administrative access.</p></div>
            <div className="field-inline oc-form-measure"><div className="oc-field"><Input aria-label="Teammate’s email" ref={emailInput} type="email" name="email" autoComplete="off" maxLength={254} required disabled={pending !== null} value={email} onChange={event => setEmail(event.target.value)} placeholder="teammate@company.com" /></div><Button type="submit" variant="primary" busy={pending?.kind === 'invite'} disabled={pending !== null}>{pending?.kind === 'invite' ? 'Inviting…' : 'Invite'}</Button></div>
            {inviteError && <Notice tone="danger">{inviteError}</Notice>}
            {success && <Notice tone="success">{success}</Notice>}
            {createdInvite && !invitations.some(item => item.email === createdInvite.email && item.inviteUrl === createdInvite.url) && <CopyField label="Private invitation link" value={createdInvite.url}/>}
          </form>
        </> : <Notice tone="info">Ask an admin to invite teammates.</Notice>}
      </Section>
      {data.role === 'admin' && <Section className="oc-management-footer" title="Organization name">
        <form className="field-inline oc-form-measure" onSubmit={event => void renameOrganization(event)}>
          <div className="oc-field"><Input ref={organizationInput} aria-label="Organization name" aria-invalid={Boolean(organizationError) || undefined} aria-describedby={organizationError ? organizationErrorId : undefined} name="organizationName" autoComplete="organization" required maxLength={100} disabled={pending !== null} value={nameValue} onChange={event => {setOrganizationName(event.target.value); setOrganizationError(''); setOrganizationSuccess('');}} /></div>
          <Button type="submit" busy={pending?.kind === 'organization'} disabled={pending !== null || !nameValue.trim() || nameValue.trim() === data.organization.name}>{pending?.kind === 'organization' ? 'Saving…' : 'Save'}</Button>
        </form>
        {organizationError && <div id={organizationErrorId}><Notice tone="danger">{organizationError}</Notice></div>}
        {organizationSuccess && <Notice tone="success">{organizationSuccess}</Notice>}
      </Section>}
      {footer}
      <Dialog open={removing !== null && data.role === 'admin'} onClose={() => {if (!pending) setRemoving(null);}} title="Remove teammate?" description={removing?.email} actions={<>
        <Button variant="quiet" disabled={pending !== null} onClick={() => setRemoving(null)}>Cancel</Button>
        <Button variant="danger" busy={pending?.kind === 'remove'} disabled={pending !== null} onClick={() => void removeMember()}>Remove teammate</Button>
      </>}>
        <p>Their access to this workspace will be revoked immediately, including existing browser, CLI, MCP and capture credentials. Their uploaded sessions and memories will remain.</p>
        <p>They will need a new invitation to rejoin.</p>
        {removalError && <Notice tone="danger">{removalError}</Notice>}
      </Dialog>
    </>}
  </TeamFrame>;
}
