import {useEffect, useRef, useState} from 'react';
import {Button, ExternalLink, Field, Notice, Section, Textarea} from '../design/components.tsx';
import type {OnboardingAdapter} from './types.ts';

export const replicasCapturePath = '/agent-setup#replicas-capture';
export const replicasCaptureGuide = 'https://docs.getopencrawl.com/agents/replicas-capture/';

export function ReplicasCaptureSetup({issue}: {issue: NonNullable<OnboardingAdapter['replicasSetup']>}) {
  const request = useRef<AbortController | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (window.location.hash === '#replicas-capture') document.getElementById('replicas-capture')?.scrollIntoView();
    return () => request.current?.abort();
  }, []);
  useEffect(() => {if (manual) {field.current?.focus(); field.current?.select();}}, [manual]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function install() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setCopied(false); setError('');
    try {
      const {prompt} = await issue(controller.signal);
      if (controller.signal.aborted) return;
      try {
        await navigator.clipboard.writeText(prompt);
        if (!controller.signal.aborted) setCopied(true);
      } catch {
        if (!controller.signal.aborted) setManual(prompt);
      }
    } catch {
      if (!controller.signal.aborted) setError('Couldn’t prepare the Replicas setup prompt. Try again.');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <Section id="replicas-capture" title="Record new Replicas chats" description="Copy the setup prompt and paste it into a chat in the Replicas environment where you want to record Claude Code and Codex. The prompt expires in 30 minutes.">
    <div className="oc-form-measure stack-sm">
      {error && <Notice tone="danger">{error}</Notice>}
      {manual ? <>
        <Field label="Prompt to copy" hint="Copy the selected text, then paste it into Replicas."><Textarea ref={field} value={manual} readOnly rows={5}/></Field>
        <div className="actions"><Button onClick={() => {setManual(''); setCopied(true); requestAnimationFrame(() => button.current?.focus());}}>I’ve copied it</Button></div>
      </> : <div className="actions"><Button ref={button} disabled={busy} onClick={() => void install()}>{busy ? 'Preparing setup…' : copied ? 'Copied' : 'Install on Replicas'}</Button></div>}
      <ExternalLink href={replicasCaptureGuide}>Replicas capture guide</ExternalLink>
    </div>
  </Section>;
}
