import type {ReactNode} from 'react';

/** A verified runtime adapter supplies these display values. They grant no authority. */
export interface WorkspaceIdentity {
  name: string;
  userName?: string;
  avatarUrl?: string | null;
  email?: string;
  role?: string;
}

export type IconName = 'cloud' | 'sign-out' | 'monitor' | 'terminal' | 'overview' | 'workspace' | 'sources' | 'usage' | 'diagnostics' | 'settings' | 'team' | 'billing' | 'data' | 'sessions' | 'memories' | 'check' | 'chevron-right' | 'chevron-left' | 'chevron-down' | 'copy' | 'plus' | 'close' | 'loader' | 'menu' | 'external' | 'refresh' | 'search' | 'warning' | 'arrow-up-right' | 'arrow-right' | 'arrow-left' | 'trash' | 'eye' | 'eye-off' | 'info' | 'dice' | 'clock' | 'infinity';

/** One route registry drives routing, page titles and the only workspace navigation. */
export interface NavigationItem {
  path: string;
  /** Other addresses that open the same section and share its sidebar entry. */
  alternatePaths?: readonly string[];
  label: string;
  icon?: IconName;
  element: ReactNode;
  group?: 'workspace' | 'manage' | 'settings';
  navigation?: boolean;
  badge?: ReactNode;
  end?: boolean;
}
