import {consoleResourceKey} from '../data.tsx';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {Button, LinkButton, Page, Textarea} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {CommandSnippet} from './copy.tsx';
import {deriveOnboarding, hasReceipt, promptModel} from './model.ts';
import {useOnboardingResource} from './resource.ts';
import {OnboardingShell} from './shell.tsx';
import type {OnboardingAdapter, OnboardingStatus} from './types.ts';

const titles = {
  connect: 'Connect your primary coding agent',
  mcp: 'Complete MCP sign-in',
  verify: 'Ask your agent to test the connection',
  session: 'Start a new coding session',
};
const descriptions = {
  connect: 'Install the OpenCrawl CLI to start recording your coding agent sessions. Your agent will guide you through sign-in, then test the connection.',
  mcp: 'Your CLI is signed in. Finish OpenCrawl’s MCP sign-in in your coding agent. Your agent will test the connection afterward.',
  verify: 'MCP is connected, but we haven’t received a successful connection test. Paste this prompt into your agent to run it.',
  session: 'Open a new session in your coding agent, then paste this small task. We’ll continue when its recording arrives.',
};

function Signal({name, label, done, pending = false, subitem = false, detail, optional = false, children}: {
  name: string; label: string; done: boolean; pending?: boolean; subitem?: boolean; detail?: string; optional?: boolean; children?: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const previousDone = useRef(done);
  useEffect(() => {
    const node = disclosure.current;
    if (done && !previousDone.current && node?.open) {
      const summary = node.querySelector('summary');
      const restore = node.contains(document.activeElement) && !summary?.contains(document.activeElement);
      node.open = false;
      if (restore) summary?.focus({preventScroll: true});
    }
    previousDone.current = done;
  }, [done]);
  const content = <>
    <Icon name="check" className="signal-mark" />
    <span><span className="signal-heading"><span className="signal-label">{label}</span>{children && <Icon name="chevron-down" className="signal-chevron" />}</span>{optional && <span className="optional-label">Optional</span>}{detail && <span className="signal-detail" data-complete={done ? '' : undefined}>{detail}</span>}</span>
    <span className="signal-status">{done ? 'Complete' : pending ? 'Pending' : 'Waiting'}</span>
  </>;
  return <li className={`${children ? 'expandable-signal' : ''}${subitem ? ' signal-subitem' : ''}`} data-signal={name} data-complete={done ? '' : undefined} data-pending={pending ? '' : undefined} data-detail={detail ? '' : undefined}>
    {children ? <details ref={disclosure} className="signal-disclosure"><summary>{content}</summary><div className="signal-command">{children}</div></details> : content}
  </li>;
}

export interface AgentOnboardingProps {
  adapter: OnboardingAdapter;
  mcpUrl: string;
  setupPrompt: string;
  initialStatus?: OnboardingStatus;
  canInviteBeforeSetup?: boolean;
  presentation?: 'focused' | 'workspace';
}

export function AgentOnboarding({adapter, mcpUrl, setupPrompt, initialStatus, canInviteBeforeSetup = false, presentation = 'focused'}: AgentOnboardingProps) {
  const progress = useOnboardingResource(signal => adapter.status(signal), {key:consoleResourceKey(adapter,'onboarding-status'), interval: 5000, initial: initialStatus});
  const status = progress.data ?? {};
  const derived = deriveOnboarding(status);
  const promptStep = derived.complete ? 'connect' : derived.step === 'ready' ? 'connect' : derived.step;
  const {commands, prompts} = promptModel({mcpUrl, setupPrompt});
  const prompt = prompts[promptStep];
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [manual, setManual] = useState<{text: string; step: string} | null>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const currentStep = useRef(promptStep);
  currentStep.current = promptStep;
  const mounted = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; if (copyTimer.current) clearTimeout(copyTimer.current);};}, []);
  useEffect(() => {
    if (manual) {fallback.current?.focus(); fallback.current?.select();}
  }, [manual]);
  useEffect(() => {setManual(null); setCopied(null);}, [promptStep]);
  const cli = hasReceipt(status.cli);
  const mcpTest = hasReceipt(status.mcpTest);
  const mcp = hasReceipt(status.mcp) || mcpTest;
  const session = hasReceipt(status.session);
  const history = hasReceipt(status.history) ? status.history?.state : undefined;
  const historyDone = history === 'complete';
  const title = !derived.complete && promptStep === 'connect' && mcp ? 'Complete CLI sign-in' : titles[promptStep];
  const description = !derived.complete && promptStep === 'connect' && mcp ? 'MCP is connected. Complete CLI sign-in to enable session recording. Your agent can guide you through the browser approval.' : descriptions[promptStep];
  function showCopied(step: string) {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(step);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }
  async function copy() {
    const requestedStep = promptStep;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt.text);
      if (mounted.current && currentStep.current === requestedStep) showCopied(requestedStep);
    } catch {
      if (mounted.current && currentStep.current === requestedStep) setManual({text: prompt.text, step: requestedStep});
    }
  }

  const Heading = presentation === 'workspace' ? 'h2' : 'h1';
  const content = <>
    {progress.loading ? <section className="focus-loading" role="status"><span className="waiting-dot" aria-hidden="true" />Checking your connection…</section>
      : progress.error ? <section aria-labelledby="error-title"><Heading id="error-title" tabIndex={-1}>Let’s reconnect</Heading><p className="focus-description">We couldn’t check your progress. Try again to pick up where you left off.</p><div className="focus-action"><Button variant="primary" onClick={progress.reload}>Try again<Icon name="arrow-right" /></Button></div><p className="focus-reassurance">You don’t need to repeat your setup.</p></section>
        : hasReceipt(status.shared) ? <section aria-labelledby="shared-title"><Heading id="shared-title">Your team’s Replicas setup is ready</Heading><p className="focus-description">Your administrator connected the shared installation. Conversations and memories from that installation are shared with your OpenCrawl workspace. You do not need to sign in or install capture separately.</p><div className="focus-action"><LinkButton to="/" variant="primary">Open workspace</LinkButton></div></section>
        : manual ? <section aria-labelledby="manual-title"><Heading id="manual-title" tabIndex={-1}>Copy this prompt</Heading><p className="focus-description">Automatic copying isn’t available. Copy the selected text, then paste it into your coding agent.</p><label className="sr-only" htmlFor="copy-fallback">Prompt to copy</label><Textarea ref={fallback} id="copy-fallback" readOnly rows={6} value={manual.text} /><div className="focus-action"><Button variant="primary" onClick={() => {showCopied(manual.step); setManual(null); requestAnimationFrame(() => copyButton.current?.focus());}}>I’ve copied it<Icon name="arrow-right" /></Button></div></section>
          : <section aria-labelledby="connect-title">
            <Heading id="connect-title" tabIndex={-1}>{title}</Heading>
            <p className="focus-description">{description}</p>
            <div className="focus-action"><div className="prompt-actions"><Button ref={copyButton} variant="primary" className="copy-prompt" data-label={prompt.label} onClick={() => void copy()}><span>{copied === promptStep ? 'Copied' : prompt.label}</span></Button><Button variant="primary" className="prompt-toggle" aria-label={`${expanded ? 'Hide' : 'Show'} ${prompt.name} prompt`} aria-expanded={expanded} aria-controls="connect-preview" onClick={() => setExpanded(value => !value)}><Icon name="chevron-down" /></Button></div></div>
            <div className="prompt-preview" id="connect-preview" hidden={!expanded}><p>{prompt.text}</p></div>
            <ul className="signal-checklist" aria-label="Connection checklist">
              <Signal name="cli" done={cli} label={cli ? 'CLI signed in' : 'Waiting for CLI sign-in'}><CommandSnippet text={commands.cli} label="Copy CLI setup commands" /><p className="signal-instruction">Open the URL printed in your terminal and approve sign-in in your browser.</p></Signal>
              <Signal name="mcp" done={mcp} label={mcp ? 'MCP signed in' : 'Waiting for MCP sign-in'}><CommandSnippet text={mcpUrl} label="Copy MCP server URL" /><p className="signal-instruction">Add this server in your agent’s settings, then complete sign-in.</p></Signal>
              <Signal name="mcpTest" done={mcpTest} pending={!mcpTest && !(cli && hasReceipt(status.mcp))} subitem label={mcpTest ? 'Connection test passed' : 'Waiting for agent to test connection'} />
              <Signal name="recording" done={session} pending={!session} label={session ? 'Session recording enabled' : 'Enable session recording'}><CommandSnippet text={commands.recording} label="Copy session recording command" /><p className="signal-instruction">Installs recording hooks and offers an optional history import.</p></Signal>
              <Signal name="session" done={session} pending={!session && !mcpTest} subitem label={session ? 'First session recording received' : 'Waiting for first session recording'}><p className="signal-instruction">Start a new chat to verify recording works.</p><p className="signal-instruction">Use the coding agent and environment you just connected. The setup chat may not be recorded.</p><p className="signal-instruction">If no recording arrives, ask your agent to check:</p><CommandSnippet text="opencrawl collect status" label="Copy recording status command" /></Signal>
              <Signal name="history" done={historyDone} pending={history !== 'importing' && !historyDone} subitem optional label="Import past sessions" detail={history === 'complete' ? 'Imported' : history === 'received' ? 'Some history received; full import unconfirmed.' : history === 'skipped' ? 'Skipped' : history === 'importing' ? 'Importing' : session ? 'Not started' : undefined}>
                {history === 'importing' ? <p className="signal-instruction">Your past sessions are being imported. You can continue setup.</p> : <><CommandSnippet text={commands.history} label="Copy history import command" /><p className="signal-instruction">Choose Claude Code, Codex, both, or skip in your terminal.</p><p className="signal-instruction">Importing uploads messages, tool activity, and available attachments.</p></>}
              </Signal>
            </ul>
            {presentation === 'focused' && !derived.complete && <p className="focus-reassurance">CLI sign-in, a successful MCP connection test, and a new session recording are required to open your workspace.</p>}
            {presentation === 'focused' && canInviteBeforeSetup && <div className="focus-action"><LinkButton to="/onboarding/invite" variant="quiet">Invite teammates now</LinkButton></div>}
          </section>}
    <p className="sr-only" role="status" aria-live="polite">{copied ? 'Copied' : derived.complete ? `All required checks passed.${presentation === 'focused' ? ' Next is available.' : ''}` : progress.error ? 'We couldn’t check your progress. Try again.' : ''}</p>
  </>;
  return presentation === 'workspace'
    ? <Page title="Agent setup" bodyClassName="focus-panel">{content}</Page>
    : <OnboardingShell step="agent" nextUrl="/onboarding/sources" nextVisible={!progress.error && !manual && derived.complete}>{content}</OnboardingShell>;
}
