import {useEffect, useState} from 'react';
import {Button, ExternalLink, LoadingState, Notice} from '../design/components.tsx';
import {CommandSnippet} from './copy.tsx';
import type {OnboardingAdapter} from './types.ts';

export const replicasAgentSetupPath = '/sources#replicas-agents';
export const replicasAgentGuide = 'https://docs.getopencrawl.com/agents/replicas/';

export function ReplicasAgentSetup({issue}: {issue: NonNullable<OnboardingAdapter['replicasSetup']>}) {
  const [attempt, setAttempt] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const request = new AbortController();
    let expiry: ReturnType<typeof setTimeout>;
    setPrompt('');
    setError('');
    void issue(request.signal).then(result => {
      if (request.signal.aborted) return;
      setPrompt(result.prompt);
      expiry = setTimeout(() => {
        setPrompt('');
        setError('This setup prompt has expired.');
      }, Date.parse(result.expiresAt) - Date.now());
    }).catch(() => {
      if (!request.signal.aborted) setError('Couldn’t prepare the Replicas setup prompt.');
    });
    return () => {request.abort(); clearTimeout(expiry);};
  }, [issue, attempt]);

  return <div className="stack-sm">
    <p>If you want the <ExternalLink href={replicasAgentGuide}>CLI, skill, and MCP</ExternalLink>, paste this prompt into a Replicas chat within 30 minutes.</p>
    {prompt ? <CommandSnippet label="Copy agent setup prompt" text={prompt}/>
      : error ? <Notice tone="danger" actions={<Button onClick={() => setAttempt(attempt + 1)}>Get a new prompt</Button>}>{error}</Notice>
      : <LoadingState label="Preparing agent setup prompt"/>}
  </div>;
}
