import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {captureSetupPrompt} from '../src/sessions/cloud-setup.mjs';
import {renderInviteOnboarding} from '../src/onboarding-invite.mjs';
import {parseInvitationEmails} from '../web/invitation-emails.js';
import {renderSourcesOnboarding} from '../src/onboarding-sources.mjs';
import {renderOnboarding} from '../src/onboarding.mjs';
import {renderWorkspace} from '../src/workspace.mjs';
import {renderDocument} from '../src/frontend-document.mjs';
import {deriveOnboarding} from '../web/onboarding-state.js';

const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const cookieName = 'opencrawl_preview';
const scenarios = new Set(['fresh', 'loading', 'cli', 'mcp-only', 'connected', 'verified', 'complete', 'history-only', 'history-importing', 'history-imported', 'history-skipped', 'sources', 'sources-loading', 'sources-error', 'source-connected', 'source-connect-error', 'invite', 'invite-ready', 'invite-error', 'error']);
const receipt = Object.freeze({observedAt: '2026-11-05T00:00:00.000Z'});
const assets = new Set(['onboarding-invite.css', 'onboarding-invite.js', 'invitation-emails.js', 'onboarding-sources.css', 'onboarding-sources.js', 'onboarding.css', 'onboarding.js', 'onboarding-state.js', 'preview-controls.js', 'workspace.css', 'workspace.js', 'frontend.css', 'tokens.css', 'controls.css', 'frame.css', 'assets/connectors/googledrive.svg', 'assets/connectors/circleback.svg', 'assets/connectors/notion.svg', 'assets/connectors/slack.svg', 'assets/connectors/granola.svg', 'assets/connectors/github.svg', 'assets/opencrawl-mark.svg', 'assets/opencrawl-mark-jitter.svg', 'assets/geist-mono.woff2', 'assets/geist-sans.woff2']);
const mime = {css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2'};
const demoResults = [
  {title: 'Demo: search launch checklist', source: 'Demo agent session', excerpt: 'The team agreed to verify search results before inviting the first users.'},
  {title: 'Demo: onboarding design decision', source: 'Demo agent session', excerpt: 'Connect the CLI, verify the MCP connection, and capture a first session before entering the workspace.'},
  {title: 'Demo: integration planning', source: 'Demo agent session', excerpt: 'Google Drive, Slack, Granola, Circleback, Notion, and GitHub are example data sources. No account is connected in this preview.'},
];
// Catalog snapshot: hosted main 7c8261e9d, app/integrations/providers.mjs. Gmail is hidden.
const sourceDefinitions = [
  ['googledrive', 'Google Drive', 'Demo shared-drive source'], ['slack', 'Slack', 'Demo conversation source'],
  ['granola', 'Granola', 'Demo meeting notes source'], ['circleback', 'Circleback', 'Demo meeting notes source'],
  ['notion', 'Notion', 'Demo workspace source'], ['github', 'GitHub', 'Demo code and issues source'],
];

function fixture(scenario) {
  const base=(scenario.startsWith('source')||scenario.startsWith('invite'))?'complete':scenario==='history-only'?'verified':['history-importing','history-imported','history-skipped'].includes(scenario)?'complete':scenario;
  const cli = ['cli', 'connected', 'verified', 'complete'].includes(base) ? {...receipt} : null;
  const data={cli, mcp: ['mcp-only', 'connected', 'verified', 'complete'].includes(base) ? {...receipt, client: 'Codex'} : null,
    mcpTest: ['verified', 'complete'].includes(base) ? {...receipt} : null,
    session: base === 'complete' ? {...receipt, harness: 'codex'} : null};
  if(scenario.startsWith('history-'))data.history={...receipt,state:scenario==='history-skipped'?'skipped':scenario==='history-importing'?'importing':'complete'};
  return data;
}

/** Disposable, unauthenticated demo only. Never mount this handler in a production server. */
export function createPreviewServer({host = '127.0.0.1', maxSessions = 128, maxBodyBytes = 4096, sessionTtlMs = 60 * 60 * 1000, publicOrigin = process.env.PREVIEW_ORIGIN} = {}) {
  const sessions = new Map();
  const configuredOrigin = publicOrigin ? new URL(publicOrigin) : null;
  if (configuredOrigin && (configuredOrigin.origin !== publicOrigin || configuredOrigin.protocol !== 'https:' || configuredOrigin.username || configuredOrigin.password)) throw new Error('PREVIEW_ORIGIN must be an exact HTTPS origin');
  const allowedHosts = new Set([host.toLowerCase().replace(/^\[|\]$/g, '')]);
  if (['127.0.0.1', 'localhost', '::1'].includes(host)) ['localhost', '127.0.0.1', '::1'].forEach(value => allowedHosts.add(value));
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      res.statusCode = status;
      res.setHeader('Content-Type', type);
      res.end(req.method === 'HEAD' ? undefined : type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    const redirect = location => { res.setHeader('Location', location); send(303, {}); };
    try {
      const authority = req.headers.host;
      let origin;
      try {
        if (configuredOrigin && authority === configuredOrigin.host) {
          origin = configuredOrigin.origin;
        } else {
          const candidate = new URL(`http://${authority}`);
          const expectedPort = String(server.address()?.port);
          if (!authority || candidate.host !== authority.toLowerCase() || candidate.username || candidate.password || !allowedHosts.has(candidate.hostname.replace(/^\[|\]$/g, '')) || (candidate.port || '80') !== expectedPort) throw new Error();
          origin = candidate.origin;
        }
      } catch { send(421, {error: 'Invalid preview host'}); return; }
      const url = new URL(req.url, origin);
      if (url.origin !== origin) { send(400, {error: 'Invalid request target'}); return; }
      // Inspect the raw target too: URL normalization must not turn traversal into an allowed asset.
      if (/%2e|%2f|%5c|\\|(?:^|\/)\.\.(?:\/|$)/i.test(req.url)) { send(404, {error: 'Not found'}); return; }
      const path = url.pathname;
      const asset = path.slice(1);
      if (assets.has(asset)) {
        if (!['GET', 'HEAD'].includes(req.method)) { send(405, {error: 'Method not allowed'}); return; }
        try { send(200, await readFile(resolve(webRoot, asset)), mime[asset.split('.').at(-1)]); }
        catch (error) { if (error.code !== 'ENOENT') throw error; send(404, {error: 'Not found'}); }
        return;
      }
      const readOnly = ['GET', 'HEAD'].includes(req.method);
      if (!readOnly && req.method !== 'POST') { send(405, {error: 'Method not allowed'}); return; }
      if (!readOnly && (![origin, configuredOrigin?.origin].filter(Boolean).includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site')) { send(403, {error: 'Same-origin request required'}); return; }
      if (!readOnly && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') && !(path === '/auth/logout' && /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) { send(415, {error: 'JSON required'}); return; }
      if (path === '/signed-out' && readOnly) {
        send(200, renderDocument('<main id="main" class="focus-onboarding"><div class="focus-content focus-panel"><h1>Preview session ended</h1><p class="focus-description">Your simulated setup progress has been cleared. No real account was signed out.</p><div class="focus-action"><a class="button-link primary" href="/?variant=panel">Return to setup</a></div></div></main>', {onboarding: true, interactive: false, title: 'Preview session ended · OpenCrawl'}), 'text/html; charset=utf-8'); return;
      }
      const now = Date.now();
      for (const [id, state] of sessions) if (now - state.updatedAt > sessionTtlMs) sessions.delete(id);
      const cookie = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      let state = sessions.get(cookie);
      if (!state) {
        if (sessions.size >= maxSessions) { send(429, {error: 'Preview session limit reached; restart preview to reset'}); return; }
        const id = randomUUID();
        state = {scenario: 'fresh', data: fixture('fresh'), sources: new Set(), invites:new Map(), queries: 0, updatedAt: now};
        sessions.set(id, state);
        res.setHeader('Set-Cookie', `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(sessionTtlMs / 1000)}`);
      }
      state.updatedAt = now;
      let body;
      if (!readOnly) {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBodyBytes) { send(413, {error: 'Request too large'}); return; }
          chunks.push(chunk);
        }
        try { body = path === '/auth/logout' ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { send(400, {error: 'Invalid JSON'}); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { send(400, {error: 'JSON object required'}); return; }
      }
      if (path === '/auth/logout') {
        if (req.method !== 'POST') { send(405, {error: 'Method not allowed'}); return; }
        sessions.delete(cookie);
        res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
        redirect('/signed-out'); return;
      }
      if (path === '/__preview/state') {
        if (req.method !== 'POST') { send(405, {error: 'Method not allowed'}); return; }
        if (!scenarios.has(body.scenario)) { send(400, {error: 'Unknown preview scenario'}); return; }
        state.scenario = body.scenario; state.data = fixture(body.scenario); state.queries = 0; state.sources.clear();state.invites.clear();delete state.sourcesLoadingUntil;if(body.scenario==='source-connected'||body.scenario.startsWith('invite'))state.sources.add('googledrive');if(body.scenario==='invite-ready')state.invites.set('alex@example.com',{email:'alex@example.com',state:'prepared'});
        send(200, {scenario: state.scenario, data: state.data}); return;
      }
      if (path === '/api/onboarding') {
        if(state.scenario==='loading'){
          state.loadingUntil??=Date.now()+3500;
          const until=state.loadingUntil;
          await new Promise(resolve=>setTimeout(resolve,Math.max(0,until-Date.now())));
          if(state.scenario==='loading'&&state.loadingUntil===until){state.scenario='fresh';delete state.loadingUntil;}
        }
        if (!readOnly) { send(405, {error: 'Method not allowed'}); return; }
        send(state.scenario === 'error' ? 503 : 200, state.scenario === 'error' ? {error: 'Preview status unavailable'} : {data: state.data}); return;
      }
      const complete = deriveOnboarding(state.data).complete;
      if (path.startsWith('/api/') && !complete) { send(403, {error: 'Complete onboarding first'}); return; }
      if (path === '/api/onboarding/history' && req.method === 'POST') {
        if(body.choice!=='skip'){send(400,{error:'Choose skip; imported history requires an observed receipt'});return;}
        state.data.history={state:'skipped',observedAt:new Date().toISOString()};
        send(200,{history:state.data.history});return;
      }
      if (['/api/search','/api/usage'].includes(path)&&state.sources.size===0){send(403,{error:'Connect at least one source',onboardingUrl:'/integrations'});return;}
      if(path==='/api/onboarding/invites'){
        if(!state.sources.size){send(403,{error:'Connect a source first',onboardingUrl:'/integrations'});return;}
        if(readOnly){send(200,{items:[...state.invites.values()],simulated:true});return;}
        if(!Array.isArray(body.emails)||body.emails.length<1||body.emails.length>10||body.emails.some(email=>typeof email!=='string')){send(400,{error:'Enter up to 10 email addresses.'});return;}
        const {emails,error}=parseInvitationEmails(body.emails.join('\n'));
        if(error){send(400,{error});return;}
        if(state.scenario==='invite-error'){state.scenario='invite';send(503,{error:'We couldn’t send your invitations. Try again.'});return;}
        const fresh=emails.filter(email=>!state.invites.has(email));
        if(state.invites.size+fresh.length>50){send(400,{error:'This preview supports up to 50 invitations.'});return;}
        for(const email of fresh)state.invites.set(email,{email,state:'prepared'});
        send(200,{items:[...state.invites.values()],addedCount:fresh.length,simulated:true});return;
      }
      if (path === '/api/search' && req.method === 'POST') {
        if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 500) { send(400, {error: 'Enter a query of 1 to 500 characters'}); return; }
        const words = (body.query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => word.length > 2 && !['what', 'did', 'about', 'the', 'and', 'for'].includes(word));
        const results = demoResults.filter(item => words.some(word => `${item.title} ${item.excerpt}`.toLowerCase().includes(word)));
        state.queries++; send(200, {results}); return;
      }
      if (path === '/api/integrations' && readOnly) {
        if(state.scenario==='sources-error'){send(503,{error:'Preview source service unavailable'});return;}
        if(state.scenario==='sources-loading'){state.sourcesLoadingUntil??=Date.now()+3500;const until=state.sourcesLoadingUntil;await new Promise(resolve=>setTimeout(resolve,Math.max(0,until-Date.now())));if(state.scenario==='sources-loading'&&state.sourcesLoadingUntil===until){state.scenario='sources';delete state.sourcesLoadingUntil;}}
        send(200, {items: sourceDefinitions.map(([id, name, description]) => ({id, name, description, icon:`/assets/connectors/${id}.svg`, state: state.sources.has(id) ? 'connected' : 'disconnected'}))}); return;
      }
      const connection = path.match(/^\/api\/integrations\/([a-z]+)\/(connect|disconnect)$/);
      if (connection && req.method === 'POST') {
        const id = connection[1];
        if (!sourceDefinitions.some(source => source[0] === id)) { send(404, {error: 'Unknown demo source'}); return; }
        if(connection[2]==='connect'&&state.scenario==='source-connect-error'){state.scenario='sources';send(503,{error:'Simulated connection failure'});return;}
        if(connection[2]==='disconnect')state.sources.delete(id);else state.sources.add(id);
        send(200, {id, state: state.sources.has(id) ? 'connected' : 'disconnected'}); return;
      }
      if (path === '/api/usage' && readOnly) { send(200, {queries: state.queries, sessions: state.data.session ? 1 : 0, sources: state.sources.size}); return; }
      if (path.startsWith('/api/')) { send(404, {error: 'Not found'}); return; }
      if (!readOnly) { send(405, {error: 'Method not allowed'}); return; }
      if (path === '/' || path === '/onboarding') {
        const content = renderOnboarding({mcpUrl: 'https://app.getopencrawl.com/mcp', setupPrompt: captureSetupPrompt('https://app.getopencrawl.com')});
        send(200, renderDocument(content, {onboarding: true, preview: true, signOutUrl: '/auth/logout', title: 'Connect your agent · OpenCrawl preview', page: 'onboarding'}), 'text/html; charset=utf-8'); return;
      }
      if(path==='/integrations'){
        if(!complete){redirect('/');return;}
        send(200,renderDocument(renderSourcesOnboarding(),{onboarding:true,preview:true,signOutUrl:'/auth/logout',title:'Connect your sources · OpenCrawl preview',page:'sources',script:'onboarding-sources',styles:['onboarding-sources']}),'text/html; charset=utf-8');return;
      }
      if(path==='/onboarding/invite'){
        if(!complete){redirect('/');return;}
        if(!state.sources.size){redirect('/integrations');return;}
        send(200,renderDocument(renderInviteOnboarding(),{onboarding:true,preview:true,signOutUrl:'/auth/logout',title:'Invite your teammates · OpenCrawl preview',page:'invite',script:'onboarding-invite',styles:['onboarding-invite']}),'text/html; charset=utf-8');return;
      }
      const page = path.slice(1);
      if (['search', 'usage'].includes(page)) {
        if (!complete) { redirect('/'); return; }
        if(state.sources.size===0){redirect('/integrations');return;}
        send(200, renderDocument(renderWorkspace({page}), {onboarding: false, preview: true, title: `${page[0].toUpperCase()}${page.slice(1)} · OpenCrawl preview`, page}), 'text/html; charset=utf-8'); return;
      }
      send(404, {error: 'Not found'});
    } catch {
      if (!res.headersSent) send(500, {error: 'Preview request failed'});
      else res.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = process.env.PREVIEW_HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  if (!['127.0.0.1', 'localhost', '::1', '100.121.97.107'].includes(host)) throw new Error('PREVIEW_HOST must be loopback or the explicitly authorized tailnet address');
  const server = createPreviewServer({host});
  server.listen(port, host, () => console.log(`Disposable OpenCrawl demo: http://${host.includes(':') ? `[${host}]` : host}:${port}`));
}
