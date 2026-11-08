import type {ReactNode} from 'react';
import {Button, LinkButton} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';
import {Link} from '../router.tsx';

export interface OnboardingShellProps {
  step: 'agent' | 'sources' | 'invite';
  children: ReactNode;
  backUrl?: string;
  nextUrl?: string;
  nextLabel?: string;
  nextVisible?: boolean;
  nextPrimary?: boolean;
  busy?: boolean;
  onNext?: () => void;
}

/** One flow frame; the application owns the header outside this component. */
export function OnboardingShell({step, children, backUrl, nextUrl, nextLabel = 'Next', nextVisible = false, nextPrimary = true, busy = false, onNext}: OnboardingShellProps) {
  return <main id="main" className="focus-onboarding" data-onboarding-step={step}>
    <div className="onboarding-flow onboarding-flow-panel">
      <div className="focus-content focus-panel">{children}</div>
      {(backUrl || nextVisible) && <nav className={`onboarding-navigation${backUrl ? ' has-back' : ''}`} aria-label="Onboarding steps">
        {backUrl && <Link className="onboarding-back" to={backUrl}><Icon name="arrow-right" />Back</Link>}
        {nextVisible && (onNext
          ? <Button id="next-step" variant={nextPrimary ? 'primary' : 'quiet'} className={`button-link${nextPrimary ? '' : ' onboarding-skip'}`} disabled={busy} aria-busy={busy} onClick={onNext}><span>{busy ? 'Opening…' : nextLabel}</span><Icon name="arrow-right" /></Button>
          : nextUrl && <LinkButton id="next-step" variant={nextPrimary ? 'primary' : 'quiet'} className={`button-link${nextPrimary ? '' : ' onboarding-skip'}`} to={nextUrl}><span>{nextLabel}</span><Icon name="arrow-right" /></LinkButton>)}
      </nav>}
    </div>
  </main>;
}
