const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
export function cloudSetupScript(api) {
  const url=new URL(api);if(url.protocol!=='https:'||url.origin!==api)throw new Error('Cloud capture requires an HTTPS API origin');
  return `#!/bin/sh
set -eu
: "\${OPENCRAWL_SESSIONS_TOKEN:?Add your OpenCrawl capture token to this personal environment first}"
export OPENCRAWL_API_URL=${quote(api)}
export OPENCRAWL_NO_UPDATE=1
npm install --prefix "$HOME/.local/share/opencrawl-cloud" --no-audit --no-fund @getopencrawl/cli@0.3.2
"$HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl" collect install --harness claude-code --no-background --json
`;
}
export function renderCloudCaptureSetup({api,credential,revoked=false}) {
  return `<main><h1>Capture Claude cloud sessions</h1><p>Use a personal Claude cloud environment. Every session using this credential uploads as your OpenCrawl account; do not put it in a shared environment.</p>
${revoked?'<p role="status">Capture credential revoked.</p>':''}
${credential?`<p>This upload-only credential expires ${escape(credential.expiresAt.slice(0,10))}. It cannot search or read sessions. Copy it into Claude’s environment variables; keep it out of chats and repositories.</p><label>Environment variable<textarea rows="3" readonly>${escape('OPENCRAWL_SESSIONS_TOKEN='+credential.token)}</textarea></label><p>Credential ID: <code>${escape(credential.id)}</code>. Save this ID to revoke access later.</p>`:'<form method="post" action="/capture/cloud"><button class="primary">Create upload-only credential</button></form>'}
<ol><li>At claude.ai/code, open the environment selector and create or edit a personal environment.</li><li>Under Network access, keep Limited/Trusted access and add <code>${escape(new URL(api).hostname)}</code>. Keep npm/package registries allowed.</li><li>Under Environment variables, add the credential above. Values are readable by sessions in this environment.</li><li>Append this script to Setup script (preserve any existing setup), then save changes.</li><li>Start a new session with that environment selected. Ask it to run a shell command, read an attached image, and check <code>opencrawl collect status</code> using the installed path below. A stored receipt confirms upload; search appears after asynchronous indexing.</li></ol>
<label>Setup script<textarea rows="10" readonly>${escape(cloudSetupScript(api))}</textarea></label>
<p>CLI path: <code>$HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl</code>. Your current setup session may need a restart; future sessions install capture before Claude starts. Capture includes messages, tool arguments/results and attachments. System prompt snapshots are omitted.</p>
<form method="post" action="/capture/cloud/revoke"><label>Credential ID to revoke<input name="id" pattern="[a-f0-9]{64}" required value="${escape(credential?.id??'')}"></label><button>Revoke credential</button></form></main>`;
}
export function captureSetupPrompt(api) {
  return `Set up OpenCrawl in this agent environment. Session collection uploads user/agent messages, tool arguments/results and attachments, omitting system prompt snapshots. Never paste credentials into chat or commit them. If CLAUDE_CODE_REMOTE=true, guide me through one-time cloud setup at ${api}/capture/cloud: use a personal Claude cloud environment, create the upload-only credential there, add ${new URL(api).hostname} to its Limited/Trusted network allowlist with npm allowed, paste the credential into Environment variables, and append the supplied setup script without replacing existing setup. These are human steps if you cannot operate settings. Start a fresh session with that environment selected; setup and first recorded session may differ. Check the installed CLI at $HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl, run a shell command and inspect an attached image, then check collect status for a stored receipt with no errors. Do not claim success from installation alone or require manual sync for the cloud test. If setup fails, report the exact failed step and guide me through fixing it. On a local machine, install npm i -g @getopencrawl/cli@next, run opencrawl login --api ${api} --no-browser --json and help me approve sign-in, then opencrawl collect install --api ${api}; verify a short test session uploads with collect status. For local-to-cloud setup, use the same ${api}/capture/cloud guide. Connect supported agents to the remote MCP server at ${api}/mcp and call test_connection; MCP is separate from session capture, so an unsupported cloud MCP path must not stop collection setup.`;
}
