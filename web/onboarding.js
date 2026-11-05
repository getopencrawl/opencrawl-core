const prompt = document.querySelector('#setup-prompt').value;
const status = document.querySelector('#copy-status');
const fallback = document.querySelector('#setup-prompt');
const timers = new WeakMap();
async function copy(value, button, label) {
  try {
    await navigator.clipboard.writeText(value);
    fallback.hidden = true;
    status.classList.add('sr-only');
    status.textContent = 'Copied';
    clearTimeout(timers.get(button));
    button.dataset.copied = '';
    button.setAttribute('aria-label', 'Copied');
    timers.set(button, setTimeout(() => {
      delete button.dataset.copied;
      if (label) button.removeAttribute('aria-label');
      else button.setAttribute('aria-label', button.dataset.copy.startsWith('npm') ? 'Copy CLI install command' : 'Copy MCP URL');
      status.textContent = '';
    }, 2000));
  } catch {
    fallback.value = value;
    fallback.hidden = false;
    fallback.focus();
    fallback.select();
    status.classList.remove('sr-only');
    status.textContent = 'Select and copy below.';
  }
}
document.querySelector('#copy-setup').addEventListener('click', event => copy(prompt, event.currentTarget, 'Copy setup prompt'));
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => copy(button.dataset.copy, button)));

const toggle = document.querySelector('#toggle-prompt');
const preview = document.querySelector('#prompt-preview');
document.querySelector('#prompt-text').textContent = prompt;
toggle.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', expanded ? 'Hide setup prompt' : 'Show setup prompt');
  preview.hidden = !expanded;
});

// Server receipts only. A copy click or elapsed time never completes a step.
const agentName = harness => ({'claude-code': 'Claude', codex: 'Codex'}[harness] || 'agent');
function showStep(id, receipt, text) {
  const step = document.querySelector('#' + id + '-step');
  const label = document.querySelector('#' + id + '-state');
  step.dataset.state = receipt ? 'complete' : (id === 'session' ? 'pending' : 'waiting');
  label.replaceChildren(text);
}
function renderStatus(data) {
  showStep('cli', data.cli, data.cli ? 'CLI signed in' : 'Waiting for CLI sign-in');
  showStep('mcp', data.mcp, data.mcp ? 'MCP signed in' : 'Waiting for MCP sign-in');
  if (data.mcp?.client) {
    const name = document.createElement('strong');
    name.textContent = data.mcp.client;
    document.querySelector('#mcp-state').append(' · ', name);
  }
  showStep('session', data.session, data.session ? 'Received a session from ' : data.cli ? 'Waiting for your first session' : 'Run a test session with your agent');
  if (data.session) {
    const name = document.createElement('strong');
    name.textContent = data.displayName ? data.displayName + '’s ' + agentName(data.session.harness) : agentName(data.session.harness);
    document.querySelector('#session-state').append(name);
  } else if (data.cli) document.querySelector('#session-step').dataset.state = 'waiting';
}
let polling = false;
async function refreshWiring() {
  if (polling || document.hidden) return;
  polling = true;
  const error = document.querySelector('#wiring-error');
  try {
    const response = await fetch('/api/onboarding', {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000)});
    if (response.status === 401) {
      error.replaceChildren('Sign in again to check your connection. ');
      const link = document.createElement('a'); link.href = '/auth/login'; link.textContent = 'Sign in';
      error.append(link); error.hidden = false; return;
    }
    if (!response.ok) throw new Error('Status unavailable');
    renderStatus((await response.json()).data);
    error.hidden = true;
  } catch {
    error.textContent = 'Connection status unavailable. Retrying…';
    error.hidden = false;
  } finally { polling = false; }
}
refreshWiring();
setInterval(refreshWiring, 5000);
document.addEventListener('visibilitychange', refreshWiring);
