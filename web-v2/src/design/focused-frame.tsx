import {useEffect} from 'react';
import type {ReactNode} from 'react';
import {Link} from '../router.tsx';

/** Shared compact frame for focused setup, separate from workspace navigation. */
export function FocusedFrame({children, footer}: {children: ReactNode; footer?: ReactNode}) {
  useEffect(() => {const previous = document.body.getAttribute('data-onboarding'); document.body.setAttribute('data-onboarding', ''); return () => {if (previous === null) document.body.removeAttribute('data-onboarding'); else document.body.setAttribute('data-onboarding', previous);};}, []);
  return <div className="oc-focused-frame"><a className="oc-skip-link" href="#main">Skip to content</a><header className="app-header"><Link className="brand" to="/" aria-label="OpenCrawl home"><img src="/assets/opencrawl-mark.svg" width="38" height="20" alt=""/><span>opencrawl</span></Link>{footer}</header>{children}</div>;
}
