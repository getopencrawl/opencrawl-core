import type {OnboardingReceipt, OnboardingSource, OnboardingStatus} from './types.ts';

export type OnboardingStep = 'connect' | 'mcp' | 'verify' | 'session' | 'ready';
export type PromptStep = Exclude<OnboardingStep, 'ready'>;

export function hasReceipt(value: OnboardingReceipt | null | undefined): boolean {
  return typeof value?.observedAt === 'string' && value.observedAt.trim() !== '' && Number.isFinite(Date.parse(value.observedAt));
}

export function deriveOnboarding(status: OnboardingStatus) {
  const milestones = [hasReceipt(status.cli), hasReceipt(status.mcpTest), hasReceipt(status.session)];
  const next = milestones.indexOf(false);
  const step: OnboardingStep = next === -1 ? 'ready' : next === 0 ? 'connect' : next === 1 ? hasReceipt(status.mcp) ? 'verify' : 'mcp' : 'session';
  return {complete: next === -1, step, completedCount: milestones.filter(Boolean).length};
}

export function isSourceConnected(source: OnboardingSource): boolean {
  return ['connected', 'syncing', 'synced'].includes(source.state);
}

/** "A, B and C" for a short list of names. */
export function listPhrase(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? '';
}

export function normalizeInvitationEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) ? email : null;
}

export function safeWorkspacePath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) throw new Error('The workspace address is invalid. Try again.');
  return value;
}

export function oauthDestination(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The sign-in destination is invalid. Try connecting again.');
  return url.href;
}

export function promptModel({mcpUrl, setupPrompt}: {mcpUrl: string; setupPrompt: string}) {
  const api = new URL(mcpUrl).origin;
  const deploymentArgs = api === 'https://app.getopencrawl.com' ? '' : ` --api ${api}`;
  return {
    commands: {
      cli: `npm i -g @getopencrawl/cli@next\nopencrawl login${deploymentArgs}`,
      recording: `opencrawl collect install${deploymentArgs}`,
      history: `opencrawl collect backfill${deploymentArgs}`,
    },
    prompts: {
      connect: {label: 'Copy setup prompt', name: 'setup', text: setupPrompt},
      mcp: {label: 'Copy MCP setup prompt', name: 'MCP setup', text: `Connect OpenCrawl’s remote MCP server at ${mcpUrl}. Guide me through sign-in, then call the OpenCrawl MCP tool test_connection and confirm it returns connected: true. Do not paste credentials into chat.`},
      verify: {label: 'Copy test prompt', name: 'test', text: 'Call the OpenCrawl MCP tool test_connection. Confirm that it returns connected: true. If OpenCrawl is not available, help me connect its remote MCP server and sign in, then retry test_connection.'},
      session: {label: 'Copy a small task', name: 'task', text: 'Tell me which project we are working in and briefly describe its purpose.'},
    },
  };
}
