import {arrowIcon as arrow} from './frontend-icons.mjs';
const searchIcon='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
/** Shared workspace presentation; runtime adapters supply authorized source and search data. */
export function renderWorkspace() {
 return `<main id="main" class="workspace-main" data-page="search">
 <div class="workspace-heading"><h1>Search your workspace</h1><p>Find the context you and your agents have collected.</p></div>
 <div id="workspace-error" class="notice error" role="alert" hidden></div>
 <form id="search-form" role="search"><label class="sr-only" for="search-query">Search your workspace</label><div class="search-field">${searchIcon}<input id="search-query" name="query" placeholder="Search for a decision, topic, or detail…" autocomplete="off" required maxlength="500"><button class="primary" type="submit"><span>Search</span>${arrow}</button></div></form>
 <p id="search-feedback" role="status" class="search-feedback"></p><section id="search-results" aria-label="Search results"></section>
 <section id="search-start" class="search-start"><h2>Start with a question</h2><p>Your sessions and connected sources are available to your agents through OpenCrawl. Search here to explore them. New content appears as indexing finishes.</p><div class="next-source"><div><h3>Add more context</h3><p>Connect more of your team’s tools whenever you’re ready.</p></div><a class="button-link" href="/integrations">Connect a source ${arrow}</a></div></section>
 </main>`;
}
