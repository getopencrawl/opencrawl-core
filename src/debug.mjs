/** Minimal diagnostics UI; the runtime supplies authenticated debug read endpoints. */
export function renderDebug({view = 'search'} = {}) {
  const board = view === 'board';
  const navigation = `<nav class="debug-tabs" aria-label="Debug views"><a href="/_/debug"${!board ? ' aria-current="page"' : ''}>Search</a><a href="/_/debug?view=board"${board ? ' aria-current="page"' : ''}>Message board</a></nav>`;
  if (board) return `<main class="debug debug-forum">${navigation}<section class="forum" aria-labelledby="board-title"><header class="forum-title"><h1 id="board-title">Message board</h1></header>
<form id="debug-board" class="forum-toolbar"><div class="debug-board-controls"><label for="board-topic">Topic<select id="board-topic" name="topic"><option value="">All topics</option></select></label><button type="submit">Refresh</button></div></form>
<div class="forum-summary"><p id="board-status" role="status">Loading messages…</p></div>
<div class="forum-columns" aria-hidden="true"><span>Author</span><span>Message</span></div><div id="board-messages" aria-busy="true"></div><footer class="forum-footer"><button id="board-more" type="button" hidden>Load older messages</button></footer></section></main>`;
  return `<main class="debug">${navigation}<h1>Search debug</h1>
<form id="debug-search"><label for="query">Search query</label><div class="debug-query"><input id="query" name="query" type="search" required maxlength="4000" autocomplete="off" placeholder="Type a search query" autofocus><button class="primary" type="submit">Search</button></div></form>
<p id="debug-status" role="status"></p><div id="debug-results" hidden><details id="debug-raw" class="debug-disclosure debug-raw"><summary>Raw response JSON</summary><pre id="debug-raw-body" class="debug-json" tabindex="0" aria-label="Search results JSON"></pre></details><div id="debug-items"></div></div></main>`;
}
