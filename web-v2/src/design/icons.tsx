import type {IconName} from '../contracts.ts';

const paths: Record<IconName, string> = {
  overview: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  sources: 'M7 7h10v10H7z M3 3h3 M18 3h3v3 M21 18v3h-3 M6 21H3v-3',
  usage: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  diagnostics: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  billing: 'M3 5h18v14H3z M3 10h18 M7 15h3',
  sessions: 'M4 4h16v12H8l-4 4Z M8 9h8 M8 12h5',
  memories: 'M6 3h9l3 3v15H6Z M14 3v4h4 M9 12h6 M9 16h4',
  data: 'M4 5c0-4 16-4 16 0s-16 4-16 0 M4 5v14c0 4 16 4 16 0V5 M4 12c0 4 16 4 16 0',
  check: 'm8 12 3 3 5-6',
  'chevron-right': 'm9 5 7 7-7 7',
  'chevron-left': 'm15 5-7 7 7 7',
  'chevron-down': 'm5 9 7 7 7-7',
  copy: 'M9 9h12v12H9z M15 5V3H3v12h2',
  plus: 'M12 5v14 M5 12h14',
  close: 'm6 6 12 12 M18 6 6 18',
  loader: 'M21 12a9 9 0 1 1-9-9',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  external: 'M15 3h6v6 M21 3 10 14 M10 3H3v18h18v-7',
  refresh: 'M20 7a9 9 0 1 0 1 9 M20 2v5h-5',
  search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  warning: 'm12 3 10 18H2Z M12 9v4 M12 17h.01',
  'arrow-right': 'M5 12h14m-5-5 5 5-5 5',
  'arrow-left': 'M19 12H5m5-5-5 5 5 5',
  'arrow-up-right': 'M7 17 17 7 M7 7h10v10',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12 M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
};

export function Icon({name, size = 20, className = ''}: {name: IconName; size?: number; className?: string}) {
  return <svg className={`oc-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{name === 'check' && <circle cx="12" cy="12" r="9"/>}<path d={paths[name]}/></svg>;
}
