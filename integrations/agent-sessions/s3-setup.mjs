#!/usr/bin/env node
// Prepares the S3 bucket agent sessions land in, using the AWS CLI and whatever sign-in it already has
// (IAM Identity Center, `aws login`, profiles). Built for agents following SETUP.md: every command prints
// JSON, changes nothing without being asked, and never prints secrets.
import { execFile } from 'node:child_process';
import { readFile, writeFile, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node s3-setup.mjs <command> [--profile <aws-profile>] [--region <region>]

  check                 AWS CLI, sign-in, account, and the bucket .env points at
  buckets               Buckets in the account, with regions
  create <bucket>       Create a private, encrypted, TLS-only bucket (--region, default from the CLI)
  connect <bucket>      Create a least-privilege IAM user for the receiver and write the bucket and
                        its keys to .env (--path, default opencrawl)

Run with the AWS CLI signed in. See SETUP.md.`;

const ENV_FILE = fileURLToPath(new URL('./.env', import.meta.url));
const USER = 'opencrawl-receiver';
const run = promisify(execFile);

/** Runs the AWS CLI and parses its JSON output. */
export async function aws(args, {profile, exec = run} = {}) {
  try {
    const {stdout} = await exec('aws', [...args, '--output', 'json'], {
      env: {...process.env, AWS_PAGER: '', ...(profile && {AWS_PROFILE: profile})},
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('The AWS CLI is not installed.'), {reason: 'no-cli'});
    const detail = (error.stderr || error.message).trim();
    const signedOut = /Unable to locate credentials|Error loading SSO Token|Token for \S+ does not exist|Token has expired|token.*(expired|invalid)|SSO session.*expired|refresh failed|ExpiredToken|aws (sso )?login/i.test(detail);
    throw Object.assign(new Error(detail), {reason: signedOut ? 'signed-out' : 'aws-error'});
  }
}

/** The receiver's permissions: check the bucket, and read and write only its own prefix. */
export function receiverPolicy(bucket, path = 'opencrawl') {
  const prefix = `${path.replace(/^\/+|\/+$/g, '')}/agent-sessions`.replace(/^\//, '');
  return {
    Version: '2012-10-17',
    Statement: [
      {Sid: 'CheckAndListBucket', Effect: 'Allow', Action: 's3:ListBucket', Resource: `arn:aws:s3:::${bucket}`},
      {Sid: 'AgentSessions', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: `arn:aws:s3:::${bucket}/${prefix}/*`},
    ],
  };
}

/** Refuses plain-HTTP access to the bucket. */
export function tlsOnlyPolicy(bucket) {
  return {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*',
      Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
      Condition: {Bool: {'aws:SecureTransport': 'false'}},
    }],
  };
}

export function validBucketName(name) {
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) && !name.includes('--') && !/^xn--|-s3alias$|--ol-s3$/.test(name);
}

async function readEnv() {
  if (!existsSync(ENV_FILE)) return {};
  return Object.fromEntries((await readFile(ENV_FILE, 'utf8')).split('\n')
    .map(line => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(([, key, value]) => [key, value]));
}

/** Sets keys in .env (created from .env.example, mode 600), keeping every other line. */
async function writeEnv(values) {
  if (!existsSync(ENV_FILE)) await copyFile(new URL('./.env.example', import.meta.url), ENV_FILE);
  let text = await readFile(ENV_FILE, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  await writeFile(ENV_FILE, text, {mode: 0o600});
  await chmod(ENV_FILE, 0o600);
}

async function defaultRegion(opts) {
  if (opts.region) return opts.region;
  try {
    const {stdout} = await run('aws', ['configure', 'get', 'region'], {env: {...process.env, ...(opts.profile && {AWS_PROFILE: opts.profile})}});
    return stdout.trim() || 'us-east-1';
  } catch {
    return 'us-east-1';
  }
}

async function bucketRegion(bucket, profile) {
  const {LocationConstraint} = await aws(['s3api', 'get-bucket-location', '--bucket', bucket], {profile});
  return LocationConstraint === 'EU' ? 'eu-west-1' : LocationConstraint || 'us-east-1';
}

const commands = {
  async check(opts) {
    const env = await readEnv();
    const configured = env.OPENCRAWL_LANDING_S3_BUCKET
      ? {bucket: env.OPENCRAWL_LANDING_S3_BUCKET, region: env.OPENCRAWL_LANDING_S3_REGION, endpoint: env.OPENCRAWL_LANDING_S3_ENDPOINT || null,
          hasKeys: Boolean(env.OPENCRAWL_LANDING_S3_ACCESS_KEY_ID && env.OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY)}
      : null;
    let cli = null;
    try {
      cli = (await run('aws', ['--version'])).stdout.trim().split(' ')[0];
    } catch {
      return {awsCli: null, signedIn: false, next: 'install-aws-cli', configured};
    }
    try {
      const identity = await aws(['sts', 'get-caller-identity'], opts);
      const region = await defaultRegion(opts);
      return {awsCli: cli, signedIn: true, account: identity.Account, identity: identity.Arn, region,
        suggestedBucket: `opencrawl-${identity.Account}-${region}`, configured, next: configured ? 'start-receiver' : 'choose-bucket'};
    } catch (error) {
      if (error.reason !== 'signed-out') throw error;
      return {awsCli: cli, signedIn: false, next: 'sign-in', detail: error.message.split('\n')[0], configured};
    }
  },

  async buckets(opts) {
    const {Buckets = []} = await aws(['s3api', 'list-buckets', '--max-buckets', '10000'], opts); // BucketRegion only comes back when paginating
    return {buckets: Buckets.map(b => ({name: b.Name, region: b.BucketRegion ?? null, created: b.CreationDate}))};
  },

  async create(opts, bucket) {
    if (!bucket || !validBucketName(bucket)) throw new Error(`"${bucket ?? ''}" is not a valid S3 bucket name: 3-63 lower-case letters, digits and hyphens.`);
    const region = await defaultRegion(opts);
    const p = {profile: opts.profile};
    await aws(['s3api', 'create-bucket', '--bucket', bucket, '--region', region,
      ...(region === 'us-east-1' ? [] : ['--create-bucket-configuration', `LocationConstraint=${region}`])], p);
    await aws(['s3api', 'put-public-access-block', '--bucket', bucket, '--public-access-block-configuration',
      'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'], p);
    await aws(['s3api', 'put-bucket-ownership-controls', '--bucket', bucket, '--ownership-controls', 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'], p);
    await aws(['s3api', 'put-bucket-encryption', '--bucket', bucket, '--server-side-encryption-configuration',
      JSON.stringify({Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'AES256'}, BucketKeyEnabled: true}]})], p);
    await aws(['s3api', 'put-bucket-policy', '--bucket', bucket, '--policy', JSON.stringify(tlsOnlyPolicy(bucket))], p);
    await aws(['s3api', 'put-bucket-tagging', '--bucket', bucket, '--tagging', 'TagSet=[{Key=app,Value=opencrawl}]'], p);
    return {created: bucket, region, private: true, encryption: 'SSE-S3', tlsOnly: true, next: 'connect'};
  },

  async connect(opts, bucket) {
    if (!bucket) throw new Error('Usage: s3-setup.mjs connect <bucket> [--path opencrawl]');
    const p = {profile: opts.profile};
    const path = opts.path || 'opencrawl';
    const region = await bucketRegion(bucket, opts.profile);
    try {
      await aws(['iam', 'get-user', '--user-name', USER], p);
    } catch (error) {
      if (!/NoSuchEntity/.test(error.message)) throw error;
      await aws(['iam', 'create-user', '--user-name', USER, '--tags', 'Key=app,Value=opencrawl'], p);
    }
    await aws(['iam', 'put-user-policy', '--user-name', USER, '--policy-name', `opencrawl-${bucket}`.slice(0, 128),
      '--policy-document', JSON.stringify(receiverPolicy(bucket, path))], p);

    // Reuse the key in .env if it still belongs to this user; otherwise issue one.
    const env = await readEnv();
    const {AccessKeyMetadata: keys = []} = await aws(['iam', 'list-access-keys', '--user-name', USER], p);
    let keyId = env.OPENCRAWL_LANDING_S3_ACCESS_KEY_ID;
    let reused = Boolean(keyId && env.OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY && keys.some(k => k.AccessKeyId === keyId && k.Status === 'Active'));
    if (!reused) {
      if (keys.length >= 2) {
        throw new Error(`IAM user ${USER} already has two access keys, and neither is in .env. Delete an unused one `
          + `(aws iam delete-access-key --user-name ${USER} --access-key-id <id>), then rerun connect.`);
      }
      const {AccessKey} = await aws(['iam', 'create-access-key', '--user-name', USER], p);
      keyId = AccessKey.AccessKeyId;
      await writeEnv({OPENCRAWL_LANDING_S3_ACCESS_KEY_ID: keyId, OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY: AccessKey.SecretAccessKey});
    }
    await writeEnv({OPENCRAWL_LANDING_S3_BUCKET: bucket, OPENCRAWL_LANDING_S3_REGION: region, OPENCRAWL_LANDING_S3_PATH: path,
      OPENCRAWL_LANDING_S3_ENDPOINT: '', COMPOSE_PROFILES: ''});
    return {connected: bucket, region, path: `${path}/agent-sessions/`, iamUser: USER, accessKeyId: keyId, keyReused: reused,
      envFile: ENV_FILE, note: 'New IAM keys can take a few seconds to work.', next: 'start-receiver'};
  },
};

async function main() {
  const {positionals, values: opts} = parseArgs({
    allowPositionals: true,
    options: {profile: {type: 'string'}, region: {type: 'string'}, path: {type: 'string'}, help: {type: 'boolean', short: 'h'}},
  });
  const [command, arg] = positionals;
  if (!commands[command] || opts.help) {
    console.log(USAGE);
    process.exit(opts.help ? 0 : 1);
  }
  try {
    console.log(JSON.stringify(await commands[command](opts, arg), null, 2));
  } catch (error) {
    console.log(JSON.stringify({error: error.message, reason: error.reason ?? 'error'}, null, 2));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
