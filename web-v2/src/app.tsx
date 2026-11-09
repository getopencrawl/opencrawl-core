import {useEffect, useId, useRef, useState} from 'react';
import type {KeyboardEvent, ReactNode} from 'react';
import {NavLink, Route, Routes, useLocation} from './router.tsx';
import type {NavigationItem, WorkspaceIdentity} from './contracts.ts';
import {Brand, Button, EmptyState, LinkButton} from './design/components.tsx';
import {Icon} from './design/icons.tsx';
import {ConsoleDataProvider, useHasConsoleCache} from './data.tsx';

export interface AppShellProps {
  workspace: WorkspaceIdentity;
  routes: ReadonlyArray<NavigationItem>;
  children?: ReactNode;
  footer?: ReactNode;
}

/** The only workspace shell. Runtime adapters supply pages, never duplicate chrome. */
export function AppShell(props: AppShellProps) {
  const provided = useHasConsoleCache();
  return provided ? <WorkspaceShell {...props}/> : <ConsoleDataProvider scopeKey="single-tenant"><WorkspaceShell {...props}/></ConsoleDataProvider>;
}
function WorkspaceShell({workspace, routes, children, footer}: AppShellProps) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountDetailsId = useId();
  const accountToggle = useRef<HTMLButtonElement>(null);
  const accountPanel = useRef<HTMLDivElement>(null);
  const accountName = workspace.userName?.trim() || workspace.email?.trim() || '';
  const hasAccountDetails = Boolean(accountName || workspace.role || footer);
  const [compact, setCompact] = useState(() => typeof matchMedia !== 'undefined' && matchMedia('(max-width: 800px)').matches);
  const navigationPanel = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const restoreNavigationFocus = useRef(false);
  const previousPath = useRef(location.pathname);
  const current = routes.find(route => route.path === location.pathname) ?? routes.find(route => route.path !== '/' && location.pathname.startsWith(route.path + '/'));
  useEffect(() => {
    const query = matchMedia('(max-width: 800px)');
    const update = () => {setCompact(query.matches); accountPanel.current?.hidePopover(); setAccountOpen(false); if (!query.matches) setMenuOpen(false);};
    query.addEventListener('change', update); return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    document.title = `OpenCrawl: ${current?.label ?? 'Workspace'}`;
    if (previousPath.current === location.pathname) return;
    previousPath.current = location.pathname;
    setMenuOpen(false);
    accountPanel.current?.hidePopover();
    setAccountOpen(false);
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-page-heading]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, current?.label]);
  useEffect(() => {
    if (compact && menuOpen) (navigationPanel.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]') ?? navigationPanel.current?.querySelector<HTMLAnchorElement>('a'))?.focus();
    else if (restoreNavigationFocus.current) {restoreNavigationFocus.current = false; if (compact) toggle.current?.focus();}
  }, [compact, menuOpen]);
  const closeAccount = () => {accountPanel.current?.hidePopover(); setAccountOpen(false); accountToggle.current?.focus();};
  const closeMenu = () => {accountPanel.current?.hidePopover(); setAccountOpen(false); restoreNavigationFocus.current = true; setMenuOpen(false);};
  const trapMenu = (event: KeyboardEvent<HTMLElement>) => {
    if (!compact || !menuOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (accountPanel.current?.matches(':popover-open')) closeAccount();
      else closeMenu();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = navigationPanel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]');
    const visible = Array.from(items ?? []).filter(item => item.getClientRects().length > 0);
    const first = visible[0]; const last = visible[visible.length - 1];
    if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
  };
  const identity = <><span className="oc-workspace-icon"><Icon name="workspace" size={20}/></span><span className="oc-account-copy"><strong title={accountName || workspace.name}>{accountName || workspace.name}</strong>{accountName && <span title={workspace.name}>{workspace.name}</span>}</span></>;
  return <div className={`oc-app${menuOpen ? ' oc-menu-open' : ''}`}>
    <a className="oc-skip-link" href="#workspace-content">Skip to content</a>
    <header className="oc-mobile-header" inert={compact && menuOpen}><Brand/><Button ref={toggle} variant="quiet" className="oc-icon-button" aria-label="Open workspace navigation" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(true)}><Icon name="menu"/></Button></header>
    {compact && menuOpen && <Button variant="plain" className="oc-nav-backdrop" aria-label="Close workspace navigation" tabIndex={-1} onClick={closeMenu}/>}
    <aside ref={navigationPanel} className="oc-sidebar" aria-label="Workspace" hidden={compact && !menuOpen} onKeyDown={trapMenu}>
      <div className="oc-nav-brand"><Brand/>{compact && <Button variant="quiet" className="oc-icon-button" aria-label="Close workspace navigation" onClick={closeMenu}><Icon name="close"/></Button>}</div>

      <nav id="workspace-navigation" aria-label="Workspace navigation">{(['workspace', 'manage'] as const).map(group => <div className="oc-nav-group" key={group}>{routes.filter(route => route.navigation !== false && (route.group ?? 'workspace') === group).map(route => <NavLink key={route.path} to={route.path} onClick={() => {if (compact) closeMenu();}} end={route.end ?? route.path === '/'} className={({isActive}) => `oc-nav-link${isActive ? ' oc-nav-active' : ''}`}><Icon name={route.icon ?? 'overview'}/><span>{route.label}</span></NavLink>)}</div>)}</nav>

      <footer className="oc-account-zone" onKeyDown={event => {if (event.key === 'Escape' && accountPanel.current?.matches(':popover-open')) {event.preventDefault(); event.stopPropagation(); closeAccount();}}}>
        {hasAccountDetails ? <>
          <div ref={accountPanel} id={accountDetailsId} className="oc-account-details" popover="auto" role="group" aria-label="Account details" onToggle={event => setAccountOpen(event.currentTarget.matches(':popover-open'))}>
            {workspace.userName && workspace.email && <span>{workspace.email}</span>}{workspace.role && <span>{workspace.role}</span>}
            {footer && <div className="oc-account-actions">{footer}</div>}
          </div>
          <Button ref={accountToggle} variant="quiet" className="oc-account-trigger" popoverTarget={accountDetailsId} aria-label={`${accountName ? `${accountName}, ` : ''}${workspace.name}. Account menu`} aria-controls={accountDetailsId} aria-expanded={accountOpen}>{identity}<Icon name="chevron-down" size={20}/></Button>
        </> : <div className="oc-account-context">{identity}</div>}
      </footer>

    </aside>
    <main id="workspace-content" className="oc-main" tabIndex={-1} inert={compact && menuOpen}>
      <div className="oc-content">{children ?? <Routes>{routes.map(route => <Route key={route.path} path={route.path} element={route.element}/>)}<Route path="*" element={<EmptyState title="Page not found" description="This page may have moved. Open the workspace home to continue." action={<LinkButton to="/">Open workspace</LinkButton>}/>}/></Routes>}</div>
    </main>
  </div>;
}
