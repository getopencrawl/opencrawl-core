/** Minimal diagnostics UI; the runtime supplies an authenticated /api/debug/search. */
export function renderDebug() {
  return `<main class="debug"><h1>Search debug</h1><p class="debug-description">Search your sessions and connected sources. OpenSearch JSON, with authorized hits only.</p>
<form id="debug-search"><label for="query">Search query</label><div class="debug-query"><input id="query" name="query" type="search" required maxlength="4000" autocomplete="off" placeholder="Type a search query" autofocus><button class="primary" type="submit">Search</button></div></form>
<p id="debug-status" role="status">Enter a query to see results.</p><pre id="debug-results" tabindex="0" aria-label="Search results JSON" hidden></pre></main>`;
}
