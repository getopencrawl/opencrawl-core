/** Product wire contracts, shared by the single-organization and hosted applications. */
export type WorkspaceRole = 'admin' | 'member';
import type {SourceSetup} from './onboarding-types.mjs';

export interface SourceCard {
  provider: string;
  name: string;
  description?: string;
  /** Catalog-selected headline statistic; unknown connectors use their highest count. */
  primaryMetric?: string;
  units?: [string, string];
  account?: string | null;
  state: 'disconnected' | 'connecting' | 'syncing' | 'synced' | 'connected' | 'error' | 'unavailable' | 'setup-required';
  setup?: SourceSetup;
  scope?: 'team' | 'user';
  auth: 'oauth' | 'api-key';
  help?: string;
  keyHelp?: {title: string; body: string; label: string; placeholder?: string};
  connectedBy?: string | null;
  connectedAt?: string | null;
  lastSyncedAt?: string | null;
  /** Provider status is refreshed independently of the page read. */
  statusUpdatedAt?: string | null;
  statusRefreshing?: boolean;
  statusUnavailable?: boolean;
  synced?: number;
  total?: number | null;
  initial?: boolean;
  finishing?: boolean;
  eta?: number | null;
  message?: string;
  reconnect?: boolean;
  recoveryAction?: 'disconnect' | 'sync' | 'connect';
  rows?: Array<{label: string; count: number; done?: boolean}>;
}

export interface TeamReport {
  organization: {id: string; name: string};
  viewerUserId: string;
  role: WorkspaceRole;
  members?: Array<{id: string; name: string | null; email: string; role: WorkspaceRole; directoryManaged?: boolean}>;
  /** inviteUrl: self-host shares the link directly because it sends no email. */
  invitations?: Array<{email: string; state?: string; inviteUrl?: string}>;
}

export interface SettingsData {
  workspace: {name: string; userName: string; email: string; role: WorkspaceRole};
  mcpUrl: string;
  setupPrompt: string;
  replicasSetupPrompt?: string;
}

export interface InvitationPolicy {delivery: 'email' | 'link'; beforeAgentSetup: boolean}
export interface Bootstrap extends SettingsData {cacheScope: string; canInvite: boolean; invitationPolicy?: InvitationPolicy; onboarding: {completed: boolean; next: string}}

export type * from './reports.mjs';
export type * from './library-types.mjs';
export type * from './onboarding-types.mjs';
