const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arrow='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>';

/** Shared placement and navigation for each step of guided setup. */
export function renderOnboardingShell(content,{panel=true,nextUrl,backUrl=null,step='agent',nextLabel='Next',nextHidden=true,nextPrimary=true}={}){
 return `<main id="main" class="focus-onboarding" data-onboarding-step="${escape(step)}"><div class="onboarding-flow${panel?' onboarding-flow-panel':''}"><div class="focus-content${panel?' focus-panel':''}">${content}</div><nav class="onboarding-navigation${backUrl?' has-back':''}" id="next-action" aria-label="Onboarding steps"${backUrl||!nextHidden?'':' hidden'}>${backUrl?`<a class="onboarding-back" href="${escape(backUrl)}">${arrow} Back</a>`:''}<a class="button-link ${nextPrimary?'primary':'onboarding-skip'}" id="next-step" href="${escape(nextUrl)}"${nextHidden?' hidden':''}><span data-next-label>${escape(nextLabel)}</span> ${arrow}</a></nav></div></main>`;
}
