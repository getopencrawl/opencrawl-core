import {useEffect, useRef, useState, type FormEvent} from 'react';
import {Button, Dialog, ExternalLink, Field, Input, Notice} from '../design/components.tsx';
import type {SourceSetup} from '../onboarding/types.ts';

export interface ConnectorSetupDialogProps {
  /** The connector that cannot start yet; null keeps the dialog closed. */
  source: {name: string; setup?: SourceSetup} | null;
  /** Which form to show. The server still requires an admin to store a credential. */
  canConfigure: boolean;
  busy?: boolean;
  error?: string;
  /** Store the credential, then continue with the connector that asked for it. */
  onSave?: (credentialId: string, value: string) => void;
  onClose: () => void;
}

/** One explanation of what a connector still needs, with the credential form when an admin can resolve it here. */
export function ConnectorSetupDialog({source, canConfigure, busy = false, error, onSave, onClose}: ConnectorSetupDialogProps) {
  const [value, setValue] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const setup = source?.setup;
  const credential = setup?.credential;
  const editable = Boolean(credential && canConfigure && onSave);
  useEffect(() => {setValue(''); if (source && editable) field.current?.focus();}, [source, editable]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (credential && onSave && value.trim()) onSave(credential.id, value.trim());
  }
  return <Dialog open={source !== null} onClose={() => {if (!busy) onClose();}} title={setup?.title || 'Connection setup'} description={setup?.body}>
    {credential ? editable ? <form className="stack" onSubmit={submit}>
      <Field label={credential.label} hint={credential.help}><Input ref={field} type="password" autoComplete="off" spellCheck={false} required value={value} onChange={event => setValue(event.target.value)} /></Field>
      <ExternalLink href={credential.url}>Get a key from {credential.name}</ExternalLink>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="actions"><Button disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={busy || !value.trim()}>{busy ? 'Checking key…' : `Save key and connect ${source?.name ?? 'source'}`}</Button></div>
    </form> : <p>Ask a workspace admin to add the {credential.name} key. It only needs to be added once.</p> : null}
  </Dialog>;
}
