import {useEffect, useRef, useState} from 'react';
import type {KeyboardEvent, ReactNode} from 'react';
import {Link, NavLink, Route, Routes, useLocation} from './router.tsx';
import type {NavigationItem, WorkspaceIdentity} from './contracts.ts';
import {Button, EmptyState, LinkButton} from './design/components.tsx';
import {Icon} from './design/icons.tsx';

export interface AppShellProps {
  workspace: WorkspaceIdentity;
  routes: ReadonlyArray<NavigationItem>;
  children?: ReactNode;
  footer?: ReactNode;
}

/** The only workspace shell. Runtime adapters supply pages, never duplicate chrome. */
export function AppShell({workspace, routes, children, footer}: AppShellProps) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 800px)').matches);
  const navigationPanel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const previousPath = useRef(location.pathname);
  const current = routes.find(route => route.path === location.pathname) ?? routes.find(route => route.path !== '/' && location.pathname.startsWith(route.path + '/'));
  useEffect(() => {
    const query = matchMedia('(max-width: 800px)');
    const update = () => {setCompact(query.matches); if (!query.matches) setMenuOpen(false);};
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.title = `${current?.label ?? 'Workspace'} · OpenCrawl`;
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    setMenuOpen(false);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-page-heading]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, current?.label]);
  useEffect(() => {if (compact && menuOpen) navigationPanel.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"],a')?.focus();}, [compact, menuOpen]);
  const closeMenu = () => {setMenuOpen(false); toggle.current?.focus();};
  const trapMenu = (event: KeyboardEvent<HTMLElement>) => {
    if (!compact || !menuOpen) return;
    if (event.key === 'Escape') {event.preventDefault(); closeMenu(); return;}
    if (event.key !== 'Tab') return;
    const items = navigationPanel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]');
    const first = items?.[0]; const last = items?.[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
  };
  return <div className={`oc-app${menuOpen ? ' oc-menu-open' : ''}`}>
    <a className="oc-skip-link" href="#workspace-content">Skip to content</a>
    <header className="oc-mobile-header"><Button ref={toggle} variant="quiet" className="oc-icon-button" aria-label="Open workspace navigation" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)}><Icon name="menu"/></Button><span>{workspace.name}</span><img src="/assets/opencrawl-mark-jitter.svg" width="38" height="22" alt="OpenCrawl"/></header>
    {compact && menuOpen && <Button variant="plain" className="oc-nav-backdrop" aria-label="Close workspace navigation" tabIndex={-1} onClick={closeMenu}/>}
    <header ref={navigationPanel} className="oc-workspace-header" aria-label="Workspace" hidden={compact && !menuOpen} onKeyDown={trapMenu}>
      <div className="oc-nav-brand"><Link to="/" aria-label="OpenCrawl home"><img src="/assets/opencrawl-mark-jitter.svg" alt="" width="46" height="24"/><span>OpenCrawl</span></Link>{compact && <Button variant="quiet" className="oc-icon-button" aria-label="Close workspace navigation" onClick={closeMenu}><Icon name="close"/></Button>}</div>
      <div className="oc-workspace-identity"><span className="oc-workspace-avatar" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</span><div><strong title={workspace.name}>{workspace.name}</strong><span>Workspace</span></div></div>
      <nav id="workspace-navigation" aria-label="Workspace navigation">{(['workspace', 'manage'] as const).map(group => <div className="oc-nav-group" key={group}>{routes.filter(route => route.navigation !== false && (route.group ?? 'workspace') === group).map(route => <NavLink key={route.path} to={route.path} end={route.end ?? route.path === '/'} className={({isActive}) => `oc-nav-link${isActive ? ' oc-nav-active' : ''}`}><Icon name={route.icon ?? 'overview'}/><span>{route.label}</span></NavLink>)}</div>)}</nav>
      <div className="oc-nav-footer"><div className="oc-user-identity"><span className="oc-user-avatar" aria-hidden="true">{(workspace.userName || workspace.email || 'You').slice(0, 1).toUpperCase()}</span><div><strong>{workspace.userName || workspace.email || 'Your account'}</strong>{workspace.email && workspace.userName && <span title={workspace.email}>{workspace.email}</span>}{workspace.role && <span>{workspace.role}</span>}</div></div>{footer}</div>
    </header>
    <main id="workspace-content" className="oc-main" tabIndex={-1} inert={compact && menuOpen}>
      <div className="oc-content">{children ?? <Routes>{routes.map(route => <Route key={route.path} path={route.path} element={route.element}/>)}<Route path="*" element={<EmptyState title="Page not found" description="This page may have moved. Open the workspace home to continue." action={<LinkButton to="/">Open workspace</LinkButton>}/>}/></Routes>}</div>
    </main>
  </div>;
}
