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

/** A one-time operator credential that an admin can add in the product to enable connectors. */
export interface ConnectorCredential {
  id: string;
  name: string;
  label: string;
  url: string;
  help: string;
  unlocks: string[];
}

/** Why a connector cannot start yet. requirement is its short caption; credential is present when an admin can resolve it here. */
export interface SourceSetup {
  title: string;
  body: string;
  requirement?: string;
  credential?: ConnectorCredential;
}

export interface OnboardingSource {
  id: string;
  name: string;
  icon?: string;
  state: string;
  setup?: SourceSetup;
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
  /** Admin only: store an operator credential named by a source's setup. Absent where the runtime manages credentials itself. */
  saveCredential?(id: string, value: string, signal: AbortSignal): Promise<{ok: true}>;
  invitations(signal: AbortSignal): Promise<InvitationList>;
  invite(email: string, signal: AbortSignal): Promise<InvitationList>;
  finish(signal: AbortSignal): Promise<{workspaceUrl: string}>;
}
