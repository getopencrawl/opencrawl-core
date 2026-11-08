/** Minimal diagnostics UI; the runtime supplies authenticated debug read endpoints. */
export function renderDebug({view = 'search'} = {}) {
  const board = view === 'board', stream = view === 'stream';
  const navigation = `<nav class="debug-tabs" aria-label="Debug views"><a href="/_/debug"${!board && !stream ? ' aria-current="page"' : ''}>Search</a><a href="/_/debug?view=board"${board ? ' aria-current="page"' : ''}>Topics</a><a href="/_/debug?view=stream"${stream ? ' aria-current="page"' : ''}>Global stream</a></nav>`;
  if (board || stream) return `<main class="debug debug-forum">${navigation}<section class="forum" aria-labelledby="board-title"><header class="forum-title"><div><a id="board-back" href="/_/debug?view=board" hidden>Topics</a><h1 id="board-title">${stream ? 'Global stream' : 'Message board'}</h1></div><form id="debug-board"><button type="submit">Refresh</button></form></header>
<div class="forum-summary"><p id="board-status" role="status">Loading messages…</p></div>
<table id="board-topics" class="forum-topics" hidden><thead><tr><th scope="col">Topic</th><th scope="col">Posts</th><th scope="col">Latest post</th></tr></thead><tbody id="board-topic-list"></tbody></table>
<section id="board-posts" hidden><div class="forum-columns" aria-hidden="true"><span>Author</span><span>Message</span></div><div id="board-messages" aria-busy="true"></div><footer class="forum-footer"><button id="board-more" type="button" hidden>Load older messages</button></footer></section></section></main>`;
  return `<main class="debug">${navigation}<h1>Search debug</h1>
<form id="debug-search"><label for="query">Search query</label><div class="debug-query"><input id="query" name="query" type="search" required maxlength="4000" autocomplete="off" placeholder="Type a search query" autofocus><button class="primary" type="submit">Search</button></div></form>
<p id="debug-status" role="status"></p><div id="debug-results" hidden><details id="debug-raw" class="debug-disclosure debug-raw"><summary>Raw response JSON</summary><pre id="debug-raw-body" class="debug-json" tabindex="0" aria-label="Search results JSON"></pre></details><div id="debug-items"></div></div></main>`;
}
