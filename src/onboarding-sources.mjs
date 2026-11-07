import {renderOnboardingShell} from './onboarding-shell.mjs';

export function renderSourcesOnboarding(){
 return renderOnboardingShell(`<section aria-labelledby="sources-title">
 <h1 id="sources-title" tabindex="-1">Connect your sources</h1>
 <p class="focus-description">Connect at least one source to give your agent more context.</p>
 <div class="connector-search" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><label class="sr-only" for="connector-query">Search connectors</label><input type="search" id="connector-query" placeholder="Search connectors…" autocomplete="off" maxlength="100" aria-controls="connector-list" disabled></div>
 <div class="connector-catalog" aria-busy="true">
 <p id="sources-loading" class="connector-message" role="status"><span class="signal-mark connector-spinner" aria-hidden="true"></span>Loading connectors…</p>
 <ul id="connector-list" aria-label="Connectors" hidden></ul>
 <div id="sources-empty" class="connector-message" hidden><p>No connectors found</p><button type="button" class="text-button" id="clear-connector-search">Clear search</button></div>
 <div id="sources-error" class="connector-message" hidden><p role="alert">We couldn’t load your connectors.</p><button type="button" id="retry-sources">Try again</button></div>
 </div><p id="sources-announcement" class="sr-only" role="status" aria-live="polite"></p>
 </section>`,{panel:true,step:'sources',nextUrl:'/onboarding/invite',backUrl:'/onboarding'});
}
