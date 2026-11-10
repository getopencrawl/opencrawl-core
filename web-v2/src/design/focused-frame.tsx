import {useEffect} from 'react';
import type {ReactNode} from 'react';
import {Brand} from './components.tsx';

/** Shared compact frame for focused setup, separate from workspace navigation. */
export function FocusedFrame({children, footer, reloadHome = false}: {children: ReactNode; footer?: ReactNode; reloadHome?:boolean}) {
  useEffect(() => {const previous = document.body.getAttribute('data-onboarding'); document.body.setAttribute('data-onboarding', ''); return () => {if (previous === null) document.body.removeAttribute('data-onboarding'); else document.body.setAttribute('data-onboarding', previous);};}, []);
  return <div className="oc-focused-frame"><a className="oc-skip-link" href="#main">Skip to content</a><header className="app-header"><Brand className="brand" reloadDocument={reloadHome}/>{footer}</header>{children}</div>;
}
