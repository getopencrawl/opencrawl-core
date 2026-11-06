const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
export function cloudSetupScript(api) {
  const url=new URL(api);if(url.protocol!=='https:'||url.origin!==api)throw new Error('Cloud capture requires an HTTPS API origin');
  // Claude's image-build setup runs before environment secrets are injected.
  // Install only code into the cached image; bind identity on the first real hook.
  const bootstrap=`const {existsSync}=require('node:fs');
const {join}=require('node:path');
const {homedir}=require('node:os');
const {spawnSync}=require('node:child_process');
const cli=join(__dirname,'node_modules/.bin/opencrawl');
const env={...process.env,OPENCRAWL_API_URL:${JSON.stringify(api)},OPENCRAWL_NO_UPDATE:'1'};
const config=join(env.OPENCRAWL_CONFIG_HOME||env.XDG_CONFIG_HOME||join(homedir(),'.config'),'opencrawl/capture/config.json');
if(!existsSync(config)) {
  const setup=spawnSync(cli,['collect','install','--harness','claude-code','--no-background','--json'],{env,stdio:['ignore','ignore','inherit']});
  if(setup.status!==0)process.exit(setup.status??1);
}
const hook=spawnSync(cli,['collect','hook','--harness','claude-code'],{env,stdio:'inherit'});
process.exit(hook.status??1);
`;
  return `#!/bin/sh
set -eu
npm install --prefix "$HOME/.local/share/opencrawl-cloud" --no-audit --no-fund @getopencrawl/cli@0.3.2
node <<'OPENCRAWL_PREPARE'
const {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync}=require('node:fs');
const {join}=require('node:path');
const {homedir}=require('node:os');
const root=join(homedir(),'.local/share/opencrawl-cloud');
const runner=join(root,'cloud-hook.cjs');
const dir=process.env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude');
const file=join(dir,'settings.json');
const settings=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};
const hooks=settings.hooks??{};
if(typeof hooks!=='object'||Array.isArray(hooks))throw new Error('Invalid existing Claude hooks');
const marker='OpenCrawl session capture';
for(const [event,groups] of Object.entries(hooks)) {
  if(!Array.isArray(groups))throw new Error('Invalid existing Claude hook groups');
  hooks[event]=groups.flatMap(group=>{
    if(!Array.isArray(group.hooks))return [group];
    const rest=group.hooks.filter(h=>h.statusMessage!==marker);
    return rest.length?[{...group,hooks:rest}]:[];
  });
}
const quote=${quote.toString()};
const command=quote(process.execPath)+' '+quote(runner);
for(const event of ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','Stop','SubagentStop','SessionEnd'])
  (hooks[event]??=[]).push({hooks:[{type:'command',command,timeout:60,statusMessage:marker}]});
mkdirSync(root,{recursive:true,mode:0o700});
mkdirSync(dir,{recursive:true,mode:0o700});
writeFileSync(runner,${JSON.stringify(bootstrap)},{mode:0o600});
writeFileSync(file+'.opencrawl-tmp',JSON.stringify({...settings,hooks})+'\\n',{mode:0o600});
renameSync(file+'.opencrawl-tmp',file);
OPENCRAWL_PREPARE
`;
}
export function renderCloudCaptureSetup({api,credential,revoked=false}) {
  return `<main class="cloud-capture"><h1>Capture Claude cloud sessions</h1><p>Use a personal Claude cloud environment. Every session using this credential is shared with your OpenCrawl team and attributed to you; do not put it in a shared environment.</p>
${revoked?'<p role="status">Capture credential revoked.</p>':''}
${credential?`<p>This upload-only credential expires ${escape(credential.expiresAt.slice(0,10))}. It cannot search or read sessions. Copy it into Claude’s environment variables; keep it out of chats and repositories.</p><label>Environment variable<textarea rows="3" readonly>${escape('OPENCRAWL_SESSIONS_TOKEN='+credential.token)}</textarea></label><p>Credential ID: <code>${escape(credential.id)}</code>. Save this ID to revoke access later.</p>`:'<form method="post" action="/capture/cloud"><button class="primary">Create upload-only credential</button></form>'}
<ol><li>At claude.ai/code, open the environment selector and create or edit a personal environment.</li><li>Under Network access, keep Limited/Trusted access and add <code>${escape(new URL(api).hostname)}</code>. Keep npm/package registries allowed.</li><li>Under Environment variables, add the credential above. Values are readable by sessions in this environment.</li><li>Append this script to Setup script (preserve any existing setup), then save changes.</li><li>Start a new session with that environment selected. Ask it to run a shell command, read an attached image, and check <code>opencrawl collect status</code> using the installed path below. A stored receipt confirms upload; search appears after asynchronous indexing.</li></ol>
<label>Setup script<textarea rows="10" readonly>${escape(cloudSetupScript(api))}</textarea></label>
<p>CLI path: <code>$HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl</code>. Your current setup session may need a restart; future sessions prepare capture in the setup script and authenticate automatically when Claude starts. Capture includes messages, tool arguments/results and attachments. System prompt snapshots are omitted.</p>
<form method="post" action="/capture/cloud/revoke"><label>Credential ID to revoke<input name="id" pattern="[a-f0-9]{64}" required value="${escape(credential?.id??'')}"></label><button>Revoke credential</button></form></main>`;
}
export function captureSetupPrompt(api) {
  return `Set up OpenCrawl in this agent environment. Session collection shares user/agent messages, tool arguments/results and attachments with my OpenCrawl team, attributed to my signed-in human account, omitting system prompt snapshots. Never paste credentials into chat or commit them. If CLAUDE_CODE_REMOTE=true, guide me through one-time cloud setup at ${api}/capture/cloud: use a personal Claude cloud environment, create the upload-only credential there, add ${new URL(api).hostname} to its Limited/Trusted network allowlist with npm allowed, paste the credential into Environment variables, and append the supplied setup script without replacing existing setup. These are human steps if you cannot operate settings. Start a fresh session with that environment selected; setup and first recorded session may differ. Check the installed CLI at $HOME/.local/share/opencrawl-cloud/node_modules/.bin/opencrawl, run a shell command and inspect an attached image, then check collect status for a stored receipt with no errors. Do not claim success from installation alone or require manual sync for the cloud test. If setup fails, report the exact failed step and guide me through fixing it. On a local machine, install npm i -g @getopencrawl/cli@next, run opencrawl login --api ${api} --no-browser --json and help me approve sign-in, then opencrawl collect install --api ${api} --json. Run opencrawl collect backfill --dry-run --api ${api} --json and show me the local transcript counts, signed-in human account and team. Ask me: "Would you like to import past local sessions from Claude Code, Codex, both, or skip?" Explain that this includes their desktop coding sessions and uploads messages, tool arguments/results, and available attachments; cloud-only chats are not included in local history. Wait for my explicit choice. Only if I approve, run opencrawl collect backfill --harness <choice> --yes --api ${api} --json, replacing <choice> with exactly claude-code, codex, or all to match my choice. If I skip or have not answered, do not backfill; continue the remaining setup. Do not treat this setup prompt as approval to import history. Report completion or errors without exposing transcript contents. Verify a short new test session uploads with collect status. For local-to-cloud setup, use the same ${api}/capture/cloud guide. Connect supported agents to the remote MCP server at ${api}/mcp and call test_connection; MCP is separate from session capture, so an unsupported cloud MCP path must not stop collection setup.`;
}
