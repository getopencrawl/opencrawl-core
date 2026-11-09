/** Product wire contracts, shared by the single-organization and hosted applications. */
export type WorkspaceRole = 'admin' | 'member';

export interface SourceCard {
  provider: string;
  name: string;
  description?: string;
  units?: [string, string];
  account?: string | null;
  state: 'disconnected' | 'connecting' | 'syncing' | 'synced' | 'connected' | 'error' | 'unavailable';
  scope?: 'team' | 'user';
  auth: 'oauth' | 'api-key';
  help?: string;
  keyHelp?: {title: string; body: string; label: string; placeholder?: string};
  connectedBy?: string | null;
  connectedAt?: string | null;
  lastSyncedAt?: string | null;
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
  members?: Array<{id: string; name: string | null; email: string; role: WorkspaceRole}>;
  invitations?: Array<{email: string; state?: string}>;
}

export interface SettingsData {
  workspace: {name: string; userName: string; email: string; role: WorkspaceRole};
  mcpUrl: string;
  setupPrompt: string;
}

export interface Bootstrap extends SettingsData {cacheScope: string; canInvite: boolean; onboarding: {completed: boolean; next: string}}

export type * from './reports.mjs';
export type * from './library-types.mjs';
export type * from './onboarding-types.mjs';
