/** Test-only HTTP adapter; does not import hosted identity or contact providers. */
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {deriveOnboarding} from '../src/onboarding/model.ts';
import type {OnboardingSource, OnboardingStatus} from '../src/onboarding/types.ts';

interface FixtureState {
  status: OnboardingStatus;
  sources: OnboardingSource[];
  invitations: {email: string;inviteUrl?:string}[];
  delayStatus: number;
  finishError: boolean;
  /** Fails the connector catalog read so the Sources step shows its retry state. */
  sourcesError?: boolean;
  /** The one operator credential value this fixture accepts. */
  acceptedCredential?: string;
  requests: {status: number; finish: number; invite: number; connect: number; aborted: number; credential: number};
}
const fresh = (): FixtureState => ({status: {}, sources: [{id: 'slack', name: 'Slack', icon: '/assets/connectors/slack.svg', state: 'disconnected', auth: 'oauth'}, {id: 'granola', name: 'Granola', icon: '/assets/connectors/granola.svg', state: 'disconnected', auth: 'api-key'}], invitations: [], delayStatus: 0, finishError: false, requests: {status: 0, finish: 0, invite: 0, connect: 0, aborted: 0, credential: 0}});
let state = fresh();
const output = await build({entryPoints: [fileURLToPath(new URL('./fixtures/onboarding-app.tsx', import.meta.url))], bundle: true, write: false, outdir: 'test-memory', format: 'esm', platform: 'browser', target: 'es2022', sourcemap: false, external: ['/assets/*']});
const javascript = output.outputFiles.find(file => file.path.endsWith('.js'))?.contents;
const css = output.outputFiles.find(file => file.path.endsWith('.css'))?.contents;
if (!javascript || !css) throw new Error('Test fixture build is incomplete');

const document = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onboarding test fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return JSON.parse(text || '{}') as Record<string, unknown>;
}
function json(res: ServerResponse, value: unknown, status = 200) {res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}).end(JSON.stringify(value));}
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/__test/state') {
    if (req.method === 'POST') {const update = await body(req); state = {...state, ...update, requests: state.requests} as FixtureState;}
    return json(res, state);
  }
  if (url.pathname === '/__test/reset') {state = {...fresh(), ...await body(req)} as FixtureState; return json(res, {ok: true});}
  if (url.pathname === '/api/onboarding') {
    state.requests.status++;
    const snapshot = state.status;
    res.on('close', () => {if (!res.writableFinished) state.requests.aborted++;});
    if (state.delayStatus) await new Promise(resolve => setTimeout(resolve, state.delayStatus));
    if (res.destroyed) return;
    return json(res, snapshot);
  }
  if (url.pathname === '/api/onboarding/sources') return state.sourcesError ? json(res, {error: 'Connectors are unavailable.'}, 503) : json(res, {items: state.sources});
  if (url.pathname === '/api/onboarding/invites') {
    if (req.method === 'POST') {
      const input = await body(req);
      const email = String(input.email || '');
      const duplicate = state.invitations.some(item => item.email === email);
      if (!duplicate) state.invitations.push({email});
      state.requests.invite++;
      return json(res, {items: state.invitations, addedCount: duplicate ? 0 : 1});
    }
    return json(res, {items: state.invitations});
  }
  if (url.pathname === '/api/onboarding/finish') {
    state.requests.finish++;
    // Sources are optional; only agent setup gates completion.
    if (state.finishError || !deriveOnboarding(state.status).complete) return json(res, {error: 'Complete the required setup checks first.'}, 409);
    return json(res, {workspaceUrl: '/'});
  }
  if (url.pathname === '/api/console/sources') return json(res, {items: state.sources.map(source => ({provider: source.id, name: source.name, state: source.state, auth: source.auth === 'api-key' ? 'api-key' : 'oauth', setup: source.setup}))});
  const credential = /^\/api\/integrations\/credentials\/([^/]+)$/.exec(url.pathname);
  if (credential) {
    state.requests.credential++;
    const input = await body(req);
    if (input.value !== (state.acceptedCredential ?? 'accepted-key')) return json(res, {error: 'Composio did not accept that key. Copy the API key from your Composio project and try again.'}, 400);
    // One accepted key unlocks every connector that was waiting for it.
    for (const source of state.sources) if (source.setup?.credential?.id === credential[1]) {delete source.setup; source.state = 'disconnected';}
    return json(res, {ok: true});
  }
  const connect = /^\/api\/integrations\/([^/]+)\/connect$/.exec(url.pathname);
  if (connect) {
    const source = state.sources.find(item => item.id === connect[1]);
    if (!source) return json(res, {error: 'Unknown source'}, 404);
    state.requests.connect++;
    const input = await body(req);
    if (source.auth === 'oauth') return json(res, {redirectUrl: 'https://provider.example/authorize'});
    if (source.auth === 'api-key' && !input.apiKey) return json(res, {error: 'API key is required.'}, 400);
    source.state = 'syncing';
    return json(res, {ok: true});
  }
  if (url.pathname === '/fixture.js') {res.writeHead(200, {'content-type': 'text/javascript'}).end(javascript); return;}
  if (url.pathname === '/fixture.css') {res.writeHead(200, {'content-type': 'text/css'}).end(css); return;}
  if (/^\/assets\/[a-zA-Z0-9_./-]+$/.test(url.pathname) && !url.pathname.includes('..')) {
    try {
      const bytes = await readFile(new URL(`../../web${url.pathname}`, import.meta.url));
      res.writeHead(200, {'content-type': url.pathname.endsWith('.woff2') ? 'font/woff2' : 'image/svg+xml'}).end(bytes);
      return;
    } catch {res.writeHead(404).end(); return;}
  }
  res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'}).end(document);
}
const server = createServer((req, res) => {void handle(req, res).catch(error => {console.error(String(error)); res.writeHead(500).end('Fixture error');});});
server.listen(Number(process.env.ONBOARDING_TEST_PORT || 43179), '127.0.0.1');
process.on('SIGTERM', () => {server.close(); server.closeAllConnections();});
