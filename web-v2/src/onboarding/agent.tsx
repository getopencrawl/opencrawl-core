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

function Signal({name, label, done, pending = false, subitem = false, detail, optional = false, active = false, children}: {
  name: string; label: string; done: boolean; pending?: boolean; subitem?: boolean; detail?: string; optional?: boolean; active?: boolean; children?: ReactNode;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const previousDone = useRef(done);
  useEffect(() => {
    const node = disclosure.current;
    if (active && !done && node) node.open = true;
    if (done && !previousDone.current && node?.open) {
      const summary = node.querySelector('summary');
      const restore = node.contains(document.activeElement) && !summary?.contains(document.activeElement);
      node.open = false;
      if (restore) summary?.focus({preventScroll: true});
    }
    previousDone.current = done;
  }, [done, active]);
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
  replicasSetupPrompt?: string;
  initialStatus?: OnboardingStatus;
  canInviteBeforeSetup?: boolean;
  presentation?: 'focused' | 'workspace';
}

export function AgentOnboarding({adapter, mcpUrl, setupPrompt, replicasSetupPrompt, initialStatus, canInviteBeforeSetup = false, presentation = 'focused'}: AgentOnboardingProps) {
  const progress = useOnboardingResource(signal => adapter.status(signal), {key:consoleResourceKey(adapter,'onboarding-status'), interval: 5000, initial: initialStatus});
  const status = progress.data ?? {};
  const derived = deriveOnboarding(status);
  const promptStep = derived.step === 'ready' ? 'connect' : derived.step;
  const showComplete = derived.complete && presentation === 'focused';
  const {commands, prompts} = promptModel({mcpUrl, setupPrompt});
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [manual, setManual] = useState<{text: string; step: string} | null>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const replicasButton = useRef<HTMLButtonElement>(null);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const currentStep = useRef(derived.step);
  currentStep.current = derived.step;
  const mounted = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; if (copyTimer.current) clearTimeout(copyTimer.current);};}, []);
  useEffect(() => {
    if (manual) {fallback.current?.focus(); fallback.current?.select();}
  }, [manual]);
  useEffect(() => {setManual(null); setCopied(null); setExpanded(false);}, [derived.step]);
  useEffect(() => {
    if (showComplete && !manual && !progress.error) document.getElementById('next-step')?.scrollIntoView({block: 'nearest'});
  }, [showComplete, manual, progress.error]);
  const cli = hasReceipt(status.cli);
  const mcpTest = hasReceipt(status.mcpTest);
  const mcp = hasReceipt(status.mcp) || mcpTest;
  const session = hasReceipt(status.session);
  const history = hasReceipt(status.history) ? status.history?.state : undefined;
  const historyDone = history === 'complete';
  const needsCli = !derived.complete && promptStep === 'connect' && mcp;
  function showCopied(step: string) {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(step);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }
  async function copy(text: string, label: string) {
    const requestedStep = derived.step;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (mounted.current && currentStep.current === requestedStep) showCopied(label);
    } catch {
      if (mounted.current && currentStep.current === requestedStep) setManual({text, step: label});
    }
  }

  const ActionHeading = presentation === 'workspace' ? 'h3' : 'h2';
  const checklist = <ul className="signal-checklist" aria-label="Connection checklist">
              <Signal name="cli" done={cli} label={cli ? 'CLI signed in' : 'Waiting for CLI sign-in'}><CommandSnippet text={commands.cli} label="Copy CLI setup commands" /><p className="signal-instruction">Open the URL printed in your terminal and approve sign-in in your browser.</p></Signal>
              <Signal name="mcp" active={promptStep === 'mcp'} done={mcp} label={mcp ? 'MCP signed in' : 'Waiting for MCP sign-in'}><ActionHeading className="signal-instruction">{titles.mcp}</ActionHeading><p className="signal-instruction">{descriptions.mcp}</p><Button variant="primary" data-prompt="mcp" onClick={() => void copy(prompts.mcp.text, 'mcp')}>{copied === 'mcp' ? 'Copied' : prompts.mcp.label}</Button><CommandSnippet text={mcpUrl} label="Copy MCP server URL" /><p className="signal-instruction">Add this server in your agent’s settings, then complete sign-in.</p></Signal>
              <Signal name="mcpTest" active={promptStep === 'verify'} done={mcpTest} pending={!mcpTest && !(cli && hasReceipt(status.mcp))} subitem label={mcpTest ? 'Connection test passed' : 'Waiting for agent to test connection'}><ActionHeading className="signal-instruction">{titles.verify}</ActionHeading><p className="signal-instruction">{descriptions.verify}</p><Button variant="primary" data-prompt="verify" onClick={() => void copy(prompts.verify.text, 'verify')}>{copied === 'verify' ? 'Copied' : prompts.verify.label}</Button></Signal>
              <Signal name="recording" done={session} pending={!session} label={session ? 'Session recording enabled' : 'Enable session recording'}><CommandSnippet text={commands.recording} label="Copy session recording command" /><p className="signal-instruction">Installs recording hooks and offers an optional history import.</p></Signal>
              <Signal name="session" active={promptStep === 'session'} done={session} pending={!session && !mcpTest} subitem label={session ? 'First session recording received' : 'Waiting for first session recording'}><ActionHeading className="signal-instruction">{titles.session}</ActionHeading><p className="signal-instruction">{descriptions.session}</p><Button variant="primary" data-prompt="session" onClick={() => void copy(prompts.session.text, 'session')}>{copied === 'session' ? 'Copied' : prompts.session.label}</Button><p className="signal-instruction">Start a new chat to verify recording works.</p><p className="signal-instruction">Use the coding agent and environment you just connected. The setup chat may not be recorded.</p><p className="signal-instruction">If no recording arrives, ask your agent to check:</p><CommandSnippet text="opencrawl collect status" label="Copy recording status command" /></Signal>
              <Signal name="history" done={historyDone} pending={history !== 'importing' && !historyDone} subitem optional label="Import past sessions" detail={history === 'complete' ? 'Imported' : history === 'received' ? 'Some history received; full import unconfirmed.' : history === 'skipped' ? 'Skipped' : history === 'importing' ? 'Importing' : session ? 'Not started' : undefined}>
                {history === 'importing' ? <p className="signal-instruction">Your past sessions are being imported. You can continue setup.</p> : <><CommandSnippet text={commands.history} label="Copy history import command" /><p className="signal-instruction">Choose Claude Code, Codex, both, or skip in your terminal.</p><p className="signal-instruction">Importing uploads messages, tool activity, and available attachments.</p></>}
              </Signal>
            </ul>;

  const replicasAction = !progress.loading && !progress.error && !manual && replicasSetupPrompt && <section aria-label="Replicas installation"><div className="focus-action"><Button ref={replicasButton} variant="primary" onClick={() => void copy(replicasSetupPrompt, 'replicas')}>{copied === 'replicas' ? 'Copied' : 'Install on Replicas'}</Button></div><p className="focus-reassurance">Copy a setup prompt to paste into a Replicas chat. Set up the shared environment once for your whole team.</p></section>;

  const Heading = presentation === 'workspace' ? 'h2' : 'h1';
  const content = <>
    {progress.loading ? <section className="focus-loading" role="status"><span className="waiting-dot" aria-hidden="true" />Checking your connection…</section>
      : progress.error ? <section aria-labelledby="error-title"><Heading id="error-title" tabIndex={-1}>Let’s reconnect</Heading><p className="focus-description">We couldn’t check your progress. Try again to pick up where you left off.</p><div className="focus-action"><Button variant="primary" onClick={progress.reload}>Try again<Icon name="arrow-right" /></Button></div><p className="focus-reassurance">You don’t need to repeat your setup.</p></section>
        : hasReceipt(status.shared) && !manual ? <section aria-labelledby="shared-title"><Heading id="shared-title">Your team’s Replicas setup is ready</Heading><p className="focus-description">Your administrator connected the shared installation. Conversations and memories from that installation are shared with your OpenCrawl workspace. You do not need to sign in or install capture separately.</p><div className="focus-action"><LinkButton to="/" variant="primary">Open workspace</LinkButton></div>{replicasAction}</section>
        : manual ? <section aria-labelledby="manual-title"><Heading id="manual-title" tabIndex={-1}>Copy this prompt</Heading><p className="focus-description">Automatic copying isn’t available. Copy the selected text, then paste it into your coding agent.</p><label className="sr-only" htmlFor="copy-fallback">Prompt to copy</label><Textarea ref={fallback} id="copy-fallback" readOnly rows={6} value={manual.text} /><div className="focus-action"><Button variant="primary" onClick={() => {showCopied(manual.step); setManual(null); requestAnimationFrame(() => (manual.step === 'replicas' ? replicasButton.current : manual.step === 'connect' ? copyButton.current : document.querySelector<HTMLButtonElement>(`[data-prompt="${manual.step}"]`))?.focus());}}>I’ve copied it<Icon name="arrow-right" /></Button></div></section>
          : <section aria-labelledby="connect-title">
            <Heading id="connect-title" tabIndex={-1}>{showComplete ? 'Your coding agent is ready' : titles.connect}</Heading>
            <p className="focus-description">{showComplete ? 'CLI sign-in, the MCP connection test, and session recording are complete. Continue to connect your data sources.' : descriptions.connect}</p>
            {!showComplete && <>
              <div className="focus-action"><div className="prompt-actions"><Button ref={copyButton} variant="primary" className="copy-prompt" data-label={prompts.connect.label} onClick={() => void copy(prompts.connect.text, 'connect')}><span>{copied === 'connect' ? 'Copied' : prompts.connect.label}</span></Button><Button variant="primary" className="prompt-toggle" aria-label={`${expanded ? 'Hide' : 'Show'} setup prompt`} aria-expanded={expanded} aria-controls="connect-preview" onClick={() => setExpanded(value => !value)}><Icon name="chevron-down" /></Button></div></div>
              <div className="prompt-preview" id="connect-preview" hidden={!expanded}><p>{prompts.connect.text}</p></div>
              {replicasAction}
              {needsCli && <p className="focus-reassurance">MCP is connected. Complete CLI sign-in to enable session recording.</p>}
            </>}
            {showComplete ? <details className="completed-setup signal-disclosure"><summary>View setup details<Icon name="chevron-down" className="signal-chevron" /></summary>{checklist}</details> : checklist}
            {presentation === 'focused' && !derived.complete && <p className="focus-reassurance">CLI sign-in, a successful MCP connection test, and a new session recording are required to open your workspace.</p>}
            {presentation === 'focused' && canInviteBeforeSetup && <div className="focus-action"><LinkButton to="/onboarding/invite" variant="quiet">Invite teammates now</LinkButton></div>}
          </section>}
    <p className="sr-only" role="status" aria-live="polite">{copied ? 'Copied' : derived.complete ? `All required checks passed.${presentation === 'focused' ? ' Next is available.' : ''}` : progress.error ? 'We couldn’t check your progress. Try again.' : ''}</p>
  </>;
  return presentation === 'workspace'
    ? <Page title="Agent setup" bodyClassName="focus-panel">{content}</Page>
    : <OnboardingShell step="agent" nextUrl="/onboarding/sources" nextVisible={!progress.error && !manual && derived.complete}>{content}</OnboardingShell>;
}
