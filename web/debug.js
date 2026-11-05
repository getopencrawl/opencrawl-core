const form = document.querySelector('#debug-search');
const input = document.querySelector('#query');
const button = form.querySelector('button');
const status = document.querySelector('#debug-status');
const results = document.querySelector('#debug-results');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query || button.disabled) return;
  button.disabled = true;
  button.textContent = 'Searching…';
  status.textContent = 'Searching…';
  status.classList.remove('debug-error');
  results.hidden = true;
  results.textContent = '';
  results.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/debug/search', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query}), signal: AbortSignal.timeout(60000)});
    if (response.status === 401) throw new Error('Your session expired. Sign in again, then retry.');
    if (!response.ok) throw new Error(response.status === 403 ? 'Workspace access could not be verified. Sign in again, then retry.' : 'Search failed. Please try again.');
    const data = await response.json();
    results.textContent = JSON.stringify(data, null, 2);
    results.hidden = false;
    status.textContent = 'Search complete.';
  } catch (error) {
    status.textContent = error.name === 'TimeoutError' ? 'Search timed out. Please try again.' : error.message;
    status.classList.add('debug-error');
  } finally {
    button.disabled = false;
    button.textContent = 'Search';
    results.setAttribute('aria-busy', 'false');
  }
});
