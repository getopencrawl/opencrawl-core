#!/usr/bin/env node
// Operator CLI: connect data sources to a self-hosted Airbyte and land them for OpenCrawl.
// Zero dependencies. Reads integrations/airbyte/.env (written by local.sh) and the process env.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createAirbyteClient, applyOAuthPayload, landingPrefix, oAuthInputConfiguration } from './client.mjs';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const USAGE = `Usage: node integrations/airbyte/cli.mjs <command>

  status                         Check Airbyte and show the workspace in use
  catalog [search]               List connectors that can be connected
  list                           List connected sources, connections and last sync
  landing                        Create (or reuse) the OpenCrawl landing destination
  connect <source-type> [opts]   Connect a source and link it to the landing destination
      --config <file.json>       Connector configuration (non-secret fields, or all of it)
      --name <name>              Source name (default: source type)
      --cron "<quartz>"          Sync schedule, e.g. "0 0 */6 * * ?" (default: manual)
      --no-oauth                 Skip browser sign-in; use credentials in --config
      --sync                     Run the first sync and wait for it
  sync <connection-id>           Run a sync and wait for it

Source types are connector names without the "source-" prefix, e.g. google-drive, notion,
slack, github, postgres. See integrations/airbyte/README.md.`;

const env = name => process.env[name] || '';
const required = name => env(name) || fail(`${name} is not set. Run integrations/airbyte/local.sh up, or see .env.example.`);

function fail(message) {
  console.error(message);
  process.exit(1);
}

const {positionals, values: opts} = parseArgs({
  allowPositionals: true,
  options: {
    config: {type: 'string'},
    name: {type: 'string'},
    cron: {type: 'string'},
    'no-oauth': {type: 'boolean'},
    sync: {type: 'boolean'},
    help: {type: 'boolean', short: 'h'},
  },
});
const [command, arg] = positionals;
if (!command || opts.help) {
  console.log(USAGE);
  process.exit(command || opts.help ? 0 : 1);
}

const airbyte = createAirbyteClient({
  url: env('AIRBYTE_URL') || 'http://localhost:8000',
  clientId: required('AIRBYTE_CLIENT_ID'),
  clientSecret: required('AIRBYTE_CLIENT_SECRET'),
});

async function workspaceId() {
  if (env('AIRBYTE_WORKSPACE_ID')) return env('AIRBYTE_WORKSPACE_ID');
  const {data} = await airbyte.listWorkspaces();
  if (!data?.length) fail('No Airbyte workspace found.');
  return data[0].workspaceId;
}

async function sourceDefinition(workspace, sourceType) {
  const {data} = await airbyte.listSourceDefinitions(workspace);
  const definition = data.find(d => d.dockerRepository === `airbyte/source-${sourceType}`);
  if (!definition) fail(`Unknown source type "${sourceType}". Try: cli.mjs catalog ${sourceType.split('-')[0]}`);
  return definition;
}

/** The S3 destination every connection writes JSONL to; the OpenCrawl indexer reads from it. */
async function landingDestination(workspace) {
  const name = env('OPENCRAWL_LANDING_NAME') || 'OpenCrawl landing';
  const bucket = required('OPENCRAWL_LANDING_S3_BUCKET');
  const {data} = await airbyte.listDestinations({workspaceIds: [workspace]});
  const existing = data.find(d => d.name === name);
  if (existing?.destinationType === 's3') return existing;
  if (existing) fail(`Destination "${name}" exists but is ${existing.destinationType}, not S3. Delete it in the Airbyte UI or set OPENCRAWL_LANDING_NAME.`);
  const configuration = {
    destinationType: 's3',
    s3_bucket_name: bucket,
    s3_bucket_path: env('OPENCRAWL_LANDING_S3_PATH') || 'opencrawl',
    s3_bucket_region: env('OPENCRAWL_LANDING_S3_REGION') || 'us-east-1',
    // S3-compatible stores (MinIO, R2, SeaweedFS); omit for AWS S3.
    ...(env('OPENCRAWL_LANDING_S3_ENDPOINT') && {s3_endpoint: env('OPENCRAWL_LANDING_S3_ENDPOINT')}),
    // Without keys, Airbyte uses the instance role / default AWS credential chain.
    ...(env('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID') && {
      access_key_id: env('OPENCRAWL_LANDING_S3_ACCESS_KEY_ID'),
      secret_access_key: required('OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY'),
    }),
    format: {format_type: 'JSONL', flattening: 'No flattening', compression: {compression_type: 'No Compression'}},
  };
  return airbyte.createDestination({workspaceId: workspace, name, configuration});
}

/** Runs the provider sign-in and returns the configuration with OAuth credentials filled in. */
async function signIn(workspace, definition, spec, configuration, sourceType) {
  const prefix = `AIRBYTE_OAUTH_${sourceType.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const clientId = env(`${prefix}_CLIENT_ID`);
  const clientSecret = env(`${prefix}_CLIENT_SECRET`);
  if (!clientId || !clientSecret) {
    fail(`${definition.name} uses OAuth. Self-managed Airbyte needs your own OAuth app:
  1. Create an OAuth app with ${definition.name} and register this redirect URL:
       ${redirectUrl()}
  2. Set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET in integrations/airbyte/.env
Or pass --no-oauth with credentials (e.g. an API token) in --config.`);
  }
  // Keys follow the connector's completeOAuthServerInputSpecification; nearly all use these two.
  const serverInput = Object.keys(spec.advancedAuth.oauthConfigSpecification?.completeOAuthServerInputSpecification?.properties || {});
  const params = {client_id: clientId, client_secret: clientSecret};
  for (const key of serverInput) if (!(key in params)) fail(`${definition.name} also needs OAuth parameter "${key}"; set it in the Airbyte UI.`);
  await airbyte.setSourceOAuthApp(workspace, definition.id, params);

  const input = oAuthInputConfiguration(spec, configuration);
  const {consentUrl} = await airbyte.getSourceConsentUrl({
    workspaceId: workspace, sourceDefinitionId: definition.id, redirectUrl: redirectUrl(), oAuthInputConfiguration: input,
  });
  console.log(`\nOpen this URL to sign in to ${definition.name}:\n\n  ${consentUrl}\n`);
  console.log('If your browser is on another machine, paste the URL it was redirected to here.');
  const queryParams = await waitForRedirect();
  const result = await airbyte.completeSourceOAuth({
    workspaceId: workspace, sourceDefinitionId: definition.id, redirectUrl: redirectUrl(), queryParams, oAuthInputConfiguration: input,
  }).catch(error => fail(`${error.message}
The provider rejected the sign-in. Check the OAuth app's client secret and redirect URL, then retry;
Airbyte server logs have the provider's response.`));
  if (!result?.request_succeeded || !result.auth_payload) fail(`Sign-in failed: ${result?.request_error || 'no credentials returned'}`);
  // Airbyte validates the stored configuration against the spec, which requires the OAuth app fields.
  return applyOAuthPayload(spec, configuration, {client_id: clientId, client_secret: clientSecret, ...result.auth_payload});
}

function redirectUrl() {
  return env('AIRBYTE_OAUTH_REDIRECT_URL') || 'http://127.0.0.1:8765/callback';
}

/** Resolves with the redirect's query parameters, from the loopback listener or a pasted URL. */
function waitForRedirect() {
  const expected = new URL(redirectUrl());
  return new Promise((resolve, reject) => {
    let server;
    const lines = createInterface({input: process.stdin});
    const done = (params, error) => {
      server?.close();
      lines.close();
      if (error) reject(error);
      else resolve(params);
    };
    const parse = url => {
      const params = Object.fromEntries(url.searchParams);
      if (params.error) return done(null, new Error(`Provider returned ${params.error}: ${params.error_description || ''}`));
      if (!params.code && !params.oauth_verifier) return false;
      done(params);
      return true;
    };
    lines.on('line', line => {
      try {
        if (!parse(new URL(line.trim()))) console.log('That URL has no code parameter; paste the full redirected URL.');
      } catch {
        console.log('Paste the full URL, starting with http.');
      }
    });
    if (['127.0.0.1', 'localhost'].includes(expected.hostname)) {
      server = createServer((req, res) => {
        const url = new URL(req.url, expected.origin);
        if (url.pathname !== expected.pathname) return res.writeHead(404).end();
        res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
        res.end('Received. You can close this tab and return to the terminal.\n');
        parse(url);
      });
      server.on('error', error => console.log(`Not listening on ${expected.host} (${error.code}); paste the URL instead.`));
      server.listen(Number(expected.port || 80), expected.hostname);
    }
  });
}

async function waitForJob(jobId) {
  let last = '';
  for (;;) {
    const job = await airbyte.getJob(jobId);
    const line = `job ${jobId}: ${job.status}${job.rowsSynced ? `, ${job.rowsSynced} rows` : ''}`;
    if (line !== last) console.log((last = line));
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

const commands = {
  async status() {
    if (!(await airbyte.health())) fail(`Airbyte is not healthy at ${env('AIRBYTE_URL') || 'http://localhost:8000'}`);
    const workspace = await workspaceId();
    console.log(`Airbyte is up. Workspace ${workspace}.`);
  },

  async catalog(search = '') {
    const {data} = await airbyte.listSourceDefinitions(await workspaceId());
    const needle = search.toLowerCase();
    const rows = data
      .map(d => ({type: d.dockerRepository.replace(/^airbyte\/source-/, ''), name: d.name}))
      .filter(d => !needle || d.type.includes(needle) || d.name.toLowerCase().includes(needle))
      .sort((a, b) => a.type.localeCompare(b.type));
    for (const row of rows) console.log(`${row.type.padEnd(40)} ${row.name}`);
    console.log(`\n${rows.length} connectors`);
  },

  async list() {
    const workspace = await workspaceId();
    const [{data: sources}, {data: connections}] = await Promise.all([
      airbyte.listSources({workspaceIds: [workspace]}),
      airbyte.listConnections({workspaceIds: [workspace]}),
    ]);
    for (const source of sources) {
      console.log(`${source.name} (${source.sourceType}) ${source.sourceId}`);
      for (const connection of connections.filter(c => c.sourceId === source.sourceId)) {
        const {data: jobs} = await airbyte.listJobs({connectionId: connection.connectionId, limit: 1});
        const job = jobs?.[0];
        console.log(`  -> ${connection.name} ${connection.connectionId} ${job ? `last sync ${job.status} ${job.startTime}` : 'never synced'}`);
      }
    }
    if (!sources.length) console.log('No sources connected. Try: cli.mjs connect <source-type>');
  },

  async landing() {
    const destination = await landingDestination(await workspaceId());
    console.log(`${destination.name} ${destination.destinationId}`);
  },

  async connect(sourceType) {
    if (!sourceType) fail('Usage: cli.mjs connect <source-type> [--config file.json]');
    const workspace = await workspaceId();
    const definition = await sourceDefinition(workspace, sourceType);
    // Check the landing prefix before sign-in so a conflict doesn't leave an orphaned source.
    const prefix = landingPrefix(opts.name || sourceType);
    if (!prefix || prefix === 'testing') fail(`"${opts.name || sourceType}" can't be used as a landing prefix; pass a different --name.`);
    const destination = await landingDestination(workspace);
    const {data: connections} = await airbyte.listConnections({workspaceIds: [workspace]});
    const clash = connections.find(c => c.destinationId === destination.destinationId && c.namespaceFormat === prefix);
    // Overwrite syncs delete older files under their prefix, so two sources must never share one.
    if (clash) fail(`Connection "${clash.name}" already lands in ${prefix}/. Pass a different --name.`);

    const spec = await airbyte.getSourceSpec(workspace, definition.id);
    let configuration = opts.config ? JSON.parse(await readFile(opts.config, 'utf8')) : {};
    if (spec.advancedAuth?.authFlowType === 'oauth2.0' && !opts['no-oauth']) {
      configuration = await signIn(workspace, definition, spec, configuration, sourceType);
    }
    const source = await airbyte.createSource({
      workspaceId: workspace, name: opts.name || sourceType, definitionId: definition.id, configuration,
    });
    console.log(`Source ${source.name} ${source.sourceId}`);

    const connection = await airbyte.createConnection({
      sourceId: source.sourceId,
      destinationId: destination.destinationId,
      name: `${source.name} → ${destination.name}`,
      // One prefix per source in the bucket: <path>/<prefix>/<stream>/...
      namespaceDefinition: 'custom_format',
      namespaceFormat: prefix,
      schedule: opts.cron ? {scheduleType: 'cron', cronExpression: opts.cron} : {scheduleType: 'manual'},
    });
    console.log(`Connection ${connection.connectionId} (${connection.configurations?.streams?.length ?? 0} streams)`);
    if (opts.sync) {
      const job = await waitForJob((await airbyte.sync(connection.connectionId)).jobId);
      if (job.status !== 'succeeded') process.exitCode = 1;
    } else {
      console.log(`Run the first sync: node integrations/airbyte/cli.mjs sync ${connection.connectionId}`);
    }
  },

  async sync(connectionId) {
    if (!connectionId) fail('Usage: cli.mjs sync <connection-id>');
    const job = await waitForJob((await airbyte.sync(connectionId)).jobId);
    if (job.status !== 'succeeded') process.exitCode = 1;
  },
};

if (!commands[command]) fail(USAGE);
try {
  await commands[command](arg);
} catch (error) {
  fail(error.message);
}
