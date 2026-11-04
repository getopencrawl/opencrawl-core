#!/usr/bin/env node
// Receives agent session transcripts from collectors and lands them in the user's S3 bucket.
// Zero dependencies. Configured by environment; see .env.example. Run with compose.yaml.
//
//   PUT  /v1/sessions/<agent>/<machine>/<session>?offset=N   append a gzip segment (or replace, at offset 0)
//   GET  /v1/sessions/<agent>/<machine>/<session>            session manifest
//   POST /mcp                                                MCP (Streamable HTTP, JSON responses)
//   GET  /install.sh, /collector.mjs                         one-line collector install
//   GET  /health
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createObjectStore, awsCredentials } from './store.mjs';

const MAX_SEGMENT = 64 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SESSION_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
const FORMATS = new Set(['jsonl', 'json']);
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Object layout, one directory per session:
 *   <prefix>/<agent>/<machine>/<session>/manifest.json
 *   <prefix>/<agent>/<machine>/<session>/<start>-<end>.<format>.gz   byte range of the source file, zero-padded
 * Concatenating a session's segments in key order reproduces the source file. JSONL segments end on a
 * line boundary, so each one can also be read on its own.
 */
export function createReceiver({store, prefix = 'agent-sessions', token = '', publicUrl = ''}) {
  const locks = new Map();
  const publicHost = publicUrl ? new URL(publicUrl).host : '';
  const trustedHost = host => LOOPBACK.test(host) || host === publicHost;

  /**
   * Blocks browsers: a web page may not drive this API (MCP requires Origin validation), and without
   * a token, DNS rebinding is stopped by accepting only loopback or the configured public host.
   */
  function fromTrustedClient(req) {
    const origin = req.headers.origin;
    if (origin !== undefined && !URL.canParse(origin)) return false;
    if (origin !== undefined && !trustedHost(new URL(origin).host)) return false;
    return Boolean(token) || trustedHost(req.headers.host ?? '');
  }
  const dir = (agent, machine, session) => `${prefix}/${agent}/${machine}/${session}/`;
  const readManifest = async key => JSON.parse((await store.get(`${key}manifest.json`)) ?? 'null');

  /** Serializes writes per session so concurrent uploads cannot interleave segments. */
  function locked(key, fn) {
    const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => locks.get(key) === tail && locks.delete(key));
    return run;
  }

  /** Appends raw bytes at offset, or replaces the session when offset is 0. */
  function writeSegment({agent, machine, session, offset, raw, gzipped, format, source = {}}) {
    const key = dir(agent, machine, session);
    return locked(key, async () => {
      const manifest = await readManifest(key);
      const length = manifest?.length ?? 0;
      if (offset !== 0 && offset !== length) return {conflict: true, length};
      let generation = manifest?.generation ?? 1;
      if (offset === 0 && manifest) {
        const {keys} = await store.list(key, {delimiter: '/'});
        await Promise.all(keys.filter(k => k.endsWith('.gz')).map(k => store.delete(k)));
        generation += 1;
      }
      const end = offset + raw.length;
      await store.put(`${key}${pad(offset)}-${pad(end)}.${format}.gz`, gzipped ?? gzipSync(raw), 'application/gzip');
      const now = new Date().toISOString();
      const next = {
        agent, machine, session, format, generation,
        length: end,
        segments: offset === 0 ? 1 : (manifest?.segments ?? 0) + 1,
        source: {...manifest?.source, ...source},
        createdAt: offset === 0 && !manifest ? now : manifest?.createdAt ?? now,
        updatedAt: now,
      };
      await store.put(`${key}manifest.json`, JSON.stringify(next, null, 2), 'application/json');
      return {manifest: next};
    });
  }

  async function summary() {
    const counts = {};
    const {keys} = await store.list(`${prefix}/`);
    for (const key of keys.filter(k => k.endsWith('/manifest.json'))) {
      const [agent, machine] = key.slice(prefix.length + 1).split('/');
      counts[agent] ??= {};
      counts[agent][machine] = (counts[agent][machine] ?? 0) + 1;
    }
    return counts;
  }

  const tools = [
    {
      name: 'save_conversation',
      description: 'Save the current conversation to OpenCrawl. Use this in chat apps that do not keep transcripts on disk '
        + '(Claude Desktop, ChatGPT, Cursor). Include every message verbatim, in order, with tool calls summarized in the '
        + 'assistant turn that made them. Call again with the same conversation_id to replace a saved copy.',
      inputSchema: {
        type: 'object',
        properties: {
          app: {type: 'string', description: 'The app you are running in, lower-case, e.g. "claude-desktop", "chatgpt", "cursor".'},
          conversation_id: {type: 'string', description: 'A stable ID for this conversation. Omit on the first save; reuse the returned one.'},
          title: {type: 'string'},
          messages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {role: {type: 'string', enum: ['user', 'assistant', 'system', 'tool']}, content: {type: 'string'}},
              required: ['role', 'content'],
            },
          },
        },
        required: ['app', 'messages'],
      },
    },
    {
      name: 'capture_status',
      description: 'Count the agent sessions OpenCrawl has captured, by agent and machine.',
      inputSchema: {type: 'object', properties: {}},
    },
  ];

  async function callTool(name, args = {}) {
    if (name === 'capture_status') return text(JSON.stringify(await summary(), null, 2));
    if (name !== 'save_conversation') throw rpcError(-32602, `Unknown tool ${name}`);
    const agent = String(args.app ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64);
    if (!NAME.test(agent)) return text('app is required, e.g. "claude-desktop".', true);
    if (!Array.isArray(args.messages) || !args.messages.length) return text('messages must be a non-empty array.', true);
    const session = args.conversation_id ? String(args.conversation_id).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 200) : randomUUID();
    const raw = Buffer.from(JSON.stringify({app: agent, conversation_id: session, title: args.title ?? null, savedAt: new Date().toISOString(), messages: args.messages}));
    await writeSegment({agent, machine: 'mcp', session, offset: 0, raw, format: 'json'});
    return text(`Saved ${args.messages.length} messages as conversation_id ${session}.`);
  }

  async function mcp(message) {
    const {id, method, params} = message;
    if (id === undefined) return null; // notification
    try {
      let result;
      if (method === 'initialize') {
        result = {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: {tools: {}},
          serverInfo: {name: 'opencrawl-agent-sessions', version: '0.1.0'},
        };
      } else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = {tools};
      else if (method === 'tools/call') result = await callTool(params?.name, params?.arguments);
      else throw rpcError(-32601, `Method not found: ${method}`);
      return {jsonrpc: '2.0', id, result};
    } catch (error) {
      return {jsonrpc: '2.0', id, error: {code: error.code ?? -32603, message: error.message}};
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://receiver');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /health') return send(res, 200, {ok: true});
    if (!fromTrustedClient(req)) return send(res, 403, {error: 'Untrusted Origin or Host. Set OPENCRAWL_SESSIONS_PUBLIC_URL to serve another host name.'});
    if (route === 'GET /collector.mjs') {
      return send(res, 200, await readFile(new URL('./collector.mjs', import.meta.url)), 'text/javascript; charset=utf-8');
    }
    if (route === 'GET /install.sh') {
      const origin = publicUrl || `http://${req.headers.host}`;
      return send(res, 200, installScript(origin.replace(/\/+$/, '')), 'text/x-shellscript; charset=utf-8');
    }
    if (token && !authorized(req.headers.authorization, token)) return send(res, 401, {error: 'Missing or wrong bearer token'});

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, {error: 'This MCP endpoint is stateless and only accepts POST'});
      let body;
      try {
        body = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      } catch {
        return send(res, 400, {jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}});
      }
      const replies = (await Promise.all([body].flat().map(mcp))).filter(Boolean);
      if (!replies.length) return res.writeHead(202).end();
      return send(res, 200, Array.isArray(body) ? replies : replies[0]);
    }

    const parts = url.pathname.split('/');
    if (parts[1] !== 'v1' || parts[2] !== 'sessions' || parts.length < 6) return send(res, 404, {error: 'Not found'});
    const [agent, machine, ...sessionParts] = parts.slice(3);
    if (!NAME.test(agent) || !NAME.test(machine) || !sessionParts.every(p => SESSION_PART.test(p))) {
      return send(res, 400, {error: 'Invalid agent, machine or session name'});
    }
    const session = sessionParts.join('/');

    if (req.method === 'GET') {
      const manifest = await readManifest(dir(agent, machine, session));
      return manifest ? send(res, 200, manifest) : send(res, 404, {error: 'No such session', length: 0});
    }
    if (req.method !== 'PUT') return send(res, 405, {error: 'Use GET or PUT'});

    const offset = Number(url.searchParams.get('offset'));
    const format = req.headers['x-opencrawl-format'] || 'jsonl';
    if (!Number.isSafeInteger(offset) || offset < 0) return send(res, 400, {error: 'offset must be a non-negative integer'});
    if (!FORMATS.has(format)) return send(res, 400, {error: `x-opencrawl-format must be one of ${[...FORMATS].join(', ')}`});
    const gzipped = await readBody(req, MAX_SEGMENT);
    let raw;
    try {
      raw = gunzipSync(gzipped, {maxOutputLength: 4 * MAX_SEGMENT});
    } catch {
      return send(res, 400, {error: 'Body must be gzip'});
    }
    if (!raw.length) return send(res, 400, {error: 'Empty segment'});
    if (format === 'jsonl' && raw.at(-1) !== 0x0a) return send(res, 400, {error: 'JSONL segments must end with a newline'});
    const source = {};
    for (const name of ['path', 'host']) {
      const value = req.headers[`x-opencrawl-source-${name}`];
      if (value) source[name] = decodeURIComponent(value);
    }
    const result = await writeSegment({agent, machine, session, offset, raw, gzipped, format, source});
    if (result.conflict) return send(res, 409, {error: `Expected offset ${result.length}`, length: result.length});
    return send(res, 200, result.manifest);
  }

  return {
    writeSegment,
    summary,
    handler: (req, res) => handle(req, res).catch(error => {
      console.error(`${req.method} ${req.url}: ${error.stack ?? error.message}`);
      if (!res.headersSent) send(res, error.status === 413 ? 413 : 500, {error: error.message});
      else res.destroy();
    }),
  };
}

function installScript(origin) {
  return `#!/bin/sh
# Installs the OpenCrawl agent session collector and starts it as a background service.
set -eu
command -v node >/dev/null 2>&1 || { echo "OpenCrawl needs Node.js 20 or newer: https://nodejs.org" >&2; exit 1; }
dir="\${OPENCRAWL_HOME:-$HOME/.opencrawl}/agent-sessions"
mkdir -p "$dir"
curl -fsSL "${origin}/collector.mjs" -o "$dir/collector.mjs.part"
mv "$dir/collector.mjs.part" "$dir/collector.mjs"
exec node "$dir/collector.mjs" install --url "${origin}" "$@"
`;
}

function authorized(header = '', token) {
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const pad = n => String(n).padStart(12, '0');
const text = (value, isError = false) => ({content: [{type: 'text', text: value}], isError});

function rpcError(code, message) {
  return Object.assign(new Error(message), {code});
}

function send(res, status, body, type = 'application/json') {
  const data = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'}).end(data);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`Body exceeds ${limit} bytes`), {status: 413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Sessions land in the S3 bucket the user configured: the same OPENCRAWL_LANDING_S3_* settings the
 * Airbyte landing destination uses, under <path>/agent-sessions/. There is no default bucket.
 */
export function storeFromEnv(env = process.env) {
  const bucket = env.OPENCRAWL_LANDING_S3_BUCKET;
  if (!bucket) throw new Error('OPENCRAWL_LANDING_S3_BUCKET is not set. Agent sessions are stored in your S3 bucket; see .env.example.');
  const accessKeyId = env.OPENCRAWL_LANDING_S3_ACCESS_KEY_ID;
  const store = createObjectStore({
    bucket,
    region: env.OPENCRAWL_LANDING_S3_REGION || 'us-east-1',
    endpoint: env.OPENCRAWL_LANDING_S3_ENDPOINT || undefined,
    credentials: accessKeyId
      ? {accessKeyId, secretAccessKey: env.OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY, sessionToken: env.OPENCRAWL_LANDING_S3_SESSION_TOKEN || undefined}
      : awsCredentials({env}),
  });
  const prefix = `${(env.OPENCRAWL_LANDING_S3_PATH || 'opencrawl').replace(/^\/+|\/+$/g, '')}/agent-sessions`.replace(/^\//, '');
  return {store, prefix};
}

async function main() {
  const env = name => process.env[name] || '';
  const {store, prefix} = storeFromEnv();
  // Retry briefly: a bundled store may still be starting, and the network may not be up yet.
  for (let attempt = 1; ; attempt++) {
    try {
      await store.checkAccess();
      break;
    } catch (error) {
      if (error.status === 403) {
        throw new Error(`${error.message}. Check the access key and secret, and that they allow s3:ListBucket on ${store.bucket}.`);
      }
      if (attempt === 15 || /does not exist|No S3 credentials/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  const receiver = createReceiver({
    store,
    prefix,
    token: env('OPENCRAWL_SESSIONS_TOKEN'),
    publicUrl: env('OPENCRAWL_SESSIONS_PUBLIC_URL'),
  });
  const port = Number(env('PORT') || 7171);
  createServer(receiver.handler).listen(port, env('HOST') || '0.0.0.0', () => {
    console.log(`Agent session receiver on :${port}, landing in ${store.location} under ${prefix}/`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
