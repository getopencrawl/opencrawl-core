import type {ReactNode} from 'react';

/** A verified runtime adapter supplies these display values. They grant no authority. */
export interface WorkspaceIdentity {
  name: string;
  userName?: string;
  email?: string;
  role?: string;
}

export type IconName = 'overview' | 'sources' | 'usage' | 'diagnostics' | 'settings' | 'team' | 'billing' | 'data' | 'check' | 'chevron-right' | 'chevron-left' | 'chevron-down' | 'copy' | 'plus' | 'close' | 'loader' | 'menu' | 'external' | 'refresh' | 'search' | 'warning' | 'arrow-up-right' | 'arrow-right' | 'arrow-left' | 'trash';

/** One route registry drives routing, page titles and the only workspace navigation. */
export interface NavigationItem {
  path: string;
  label: string;
  icon?: IconName;
  element: ReactNode;
  group?: 'workspace' | 'manage';
  navigation?: boolean;
  end?: boolean;
}
