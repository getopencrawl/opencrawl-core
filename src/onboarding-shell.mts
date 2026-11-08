import {escapeHtml as escape} from './frontend-html.mjs';
import {arrowIcon as arrow} from './frontend-icons.mjs';

/** Shared placement and navigation for each step of guided setup. */
export function renderOnboardingShell(content: string,{nextUrl,backUrl=null,step='agent',nextLabel='Next',nextHidden=true,nextPrimary=true}: {nextUrl?: string; backUrl?: string | null; step?: string; nextLabel?: string; nextHidden?: boolean; nextPrimary?: boolean}={}){
 return `<main id="main" class="focus-onboarding" data-onboarding-step="${escape(step)}"><div class="onboarding-flow onboarding-flow-panel"><div class="focus-content focus-panel">${content}</div><nav class="onboarding-navigation${backUrl?' has-back':''}" id="next-action" aria-label="Onboarding steps"${backUrl||!nextHidden?'':' hidden'}>${backUrl?`<a class="onboarding-back" href="${escape(backUrl)}">${arrow} Back</a>`:''}<a class="button-link ${nextPrimary?'primary':'onboarding-skip'}" id="next-step" href="${escape(nextUrl)}"${nextHidden?' hidden':''}><span data-next-label>${escape(nextLabel)}</span> ${arrow}</a></nav></div></main>`;
}
