/** Receipts are authoritative observations, never client-side progress flags. */
export interface OnboardingReceipt {
  observedAt: string;
}

export interface OnboardingStatus {
  cli?: OnboardingReceipt | null;
  mcp?: (OnboardingReceipt & {client?: string | null}) | null;
  mcpTest?: OnboardingReceipt | null;
  session?: (OnboardingReceipt & {harness?: string}) | null;
  history?: (OnboardingReceipt & {state?: 'received' | 'importing' | 'complete' | 'skipped'}) | null;
  completed?: OnboardingReceipt | null;
}

export interface OnboardingSource {
  id: string;
  name: string;
  icon?: string;
  state: string;
  auth?: string;
  keyHelp?: {title?: string; body?: string; label?: string; placeholder?: string};
}

export interface InvitationList {
  items: {email: string;inviteUrl?:string}[];
  addedCount?: number;
}

/** Runtime adapters own authorization, persistence, invitation delivery, and OAuth. */
export interface OnboardingAdapter {
  status(signal: AbortSignal): Promise<OnboardingStatus>;
  sources(signal: AbortSignal): Promise<{items: OnboardingSource[]}>;
  connectSource(id: string, input: {apiKey?: string}, signal: AbortSignal): Promise<{redirectUrl?: string; ok?: boolean}>;
  invitations(signal: AbortSignal): Promise<InvitationList>;
  invite(email: string, signal: AbortSignal): Promise<InvitationList>;
  finish(signal: AbortSignal): Promise<{workspaceUrl: string}>;
}
