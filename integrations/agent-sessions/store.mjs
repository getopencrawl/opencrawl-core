/**
 * Minimal S3 client: enough for the receiver to land session segments in the user's S3 bucket
 * (AWS S3, or any S3-compatible store such as Cloudflare R2, Garage or SeaweedFS).
 * Zero dependencies: global fetch plus AWS Signature Version 4.
 *
 *   const store = createObjectStore({bucket, region, credentials: awsCredentials()});
 *   await store.put('a/b.json', Buffer.from('{}'), 'application/json');
 */
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Without an endpoint, talks to AWS S3 in region, virtual-hosted style. With one, uses path style,
 * which S3-compatible stores expect. credentials is {accessKeyId, secretAccessKey, sessionToken?}
 * or an async function returning that (see awsCredentials).
 */
export function createObjectStore({endpoint, region = 'us-east-1', bucket, credentials, fetch: fetchImpl = globalThis.fetch}) {
  if (!bucket) throw new Error('S3 bucket is required');
  if (!credentials) throw new Error('S3 credentials are required');
  const resolve = typeof credentials === 'function' ? credentials : async () => credentials;
  const root = endpoint
    ? `${endpoint.replace(/\/+$/, '')}/${bucket}`
    : bucket.includes('.') ? `https://s3.${region}.amazonaws.com/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;

  async function request(method, key, {query = {}, body, headers = {}} = {}) {
    const url = new URL(`${root}/${key === undefined ? '' : key.split('/').map(encode).join('/')}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value);
    const {accessKeyId, secretAccessKey, sessionToken} = await resolve();
    const signed = signRequest({
      method, url, body, region, accessKeyId, secretAccessKey,
      headers: sessionToken ? {...headers, 'x-amz-security-token': sessionToken} : headers,
    });
    const res = await fetchImpl(url, {method, headers: signed, body});
    if (!res.ok && !(res.status === 404 && method !== 'PUT')) throw await storeError(res, `${method} ${key ?? bucket}`);
    return res;
  }

  return {
    bucket,
    location: endpoint ? `${endpoint} bucket ${bucket}` : `s3://${bucket} (${region})`,

    /** Confirms the bucket exists and these credentials can reach it. Never creates a bucket. */
    async checkAccess() {
      const res = await request('HEAD');
      if (res.status === 404) throw new Error(`S3 bucket ${bucket} does not exist. Create it, or fix OPENCRAWL_LANDING_S3_BUCKET.`);
    },

    put: (key, body, contentType = 'application/octet-stream') =>
      request('PUT', key, {body, headers: {'content-type': contentType}}).then(() => undefined),

    /** Returns the object as a Buffer, or null if it does not exist. */
    async get(key) {
      const res = await request('GET', key);
      return res.status === 404 ? null : Buffer.from(await res.arrayBuffer());
    },

    delete: key => request('DELETE', key).then(() => undefined),

    /** Lists keys under prefix. With delimiter '/', returns direct children only, plus subdirectory prefixes. */
    async list(prefix, {delimiter} = {}) {
      const keys = [];
      const prefixes = [];
      let token;
      do {
        const res = await request('GET', undefined, {query: {'list-type': '2', prefix, delimiter, 'continuation-token': token}});
        const xml = await res.text();
        for (const [, key] of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(key));
        for (const [, p] of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)) prefixes.push(unescapeXml(p));
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(xml.match(/<NextContinuationToken>([^<]*)</)?.[1] ?? '') : undefined;
      } while (token);
      return {keys, prefixes};
    },
  };
}

/**
 * Resolves AWS credentials the way the AWS SDKs do, minus shared config files: environment keys,
 * EKS web identity (IRSA), ECS / EKS Pod Identity container credentials, then the EC2 instance role.
 * Temporary credentials are cached and refreshed five minutes before they expire.
 */
export function awsCredentials({env = process.env, fetch: fetchImpl = globalThis.fetch} = {}) {
  let cached = null;
  return async () => {
    if (cached && (!cached.expiration || cached.expiration - Date.now() > 5 * 60_000)) return cached;
    cached = await loadCredentials(env, fetchImpl);
    return cached;
  };
}

async function loadCredentials(env, fetchImpl) {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN};
  }
  const temporary = c => ({
    accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token ?? c.SessionToken,
    expiration: c.Expiration ? Date.parse(c.Expiration) : 0,
  });

  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) {
    const sts = new URL(`https://sts.${env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1'}.amazonaws.com/`);
    for (const [name, value] of Object.entries({
      Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: env.AWS_ROLE_ARN,
      RoleSessionName: env.AWS_ROLE_SESSION_NAME || 'opencrawl-agent-sessions',
      WebIdentityToken: (await readFile(env.AWS_WEB_IDENTITY_TOKEN_FILE, 'utf8')).trim(),
    })) sts.searchParams.set(name, value);
    const res = await fetchImpl(sts);
    const xml = await res.text();
    if (!res.ok) throw new Error(`AssumeRoleWithWebIdentity failed with ${res.status}: ${xml.match(/<Message>([^<]*)</)?.[1] ?? ''}`);
    const field = name => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
    return temporary({AccessKeyId: field('AccessKeyId'), SecretAccessKey: field('SecretAccessKey'), Token: field('SessionToken'), Expiration: field('Expiration')});
  }

  const container = env.AWS_CONTAINER_CREDENTIALS_FULL_URI
    || (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`);
  if (container) {
    const authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
      || (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE && (await readFile(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8')).trim());
    const res = await fetchImpl(container, {headers: authorization ? {Authorization: authorization} : {}});
    if (!res.ok) throw new Error(`Container credentials endpoint returned ${res.status}`);
    return temporary(await res.json());
  }

  // EC2 instance metadata (IMDSv2).
  const imds = env.AWS_EC2_METADATA_SERVICE_ENDPOINT?.replace(/\/+$/, '') || 'http://169.254.169.254';
  try {
    const signal = () => AbortSignal.timeout(1000);
    const token = await (await fetchImpl(`${imds}/latest/api/token`, {
      method: 'PUT', headers: {'X-aws-ec2-metadata-token-ttl-seconds': '21600'}, signal: signal(),
    })).text();
    const headers = {'X-aws-ec2-metadata-token': token};
    const base = `${imds}/latest/meta-data/iam/security-credentials/`;
    const role = (await (await fetchImpl(base, {headers, signal: signal()})).text()).split('\n')[0].trim();
    const res = await fetchImpl(`${base}${role}`, {headers, signal: signal()});
    if (role && res.ok) return temporary(await res.json());
  } catch {}
  throw new Error('No S3 credentials. Set OPENCRAWL_LANDING_S3_ACCESS_KEY_ID and OPENCRAWL_LANDING_S3_SECRET_ACCESS_KEY, '
    + 'or run where an AWS role is available (EC2 instance role, ECS task role, EKS IRSA or Pod Identity).');
}

/** Returns headers for an AWS Signature Version 4 request. Exported for tests. */
export function signRequest({method, url, headers = {}, body, region, accessKeyId, secretAccessKey, service = 's3', date = new Date()}) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])),
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': sha256(body ?? ''),
  };
  const names = Object.keys(all).sort();
  const query = [...url.searchParams]
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const canonical = [method, url.pathname, query, ...names.map(name => `${name}:${all[name]}`), '', names.join(';'), all['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key = `AWS4${secretAccessKey}`;
  for (const part of [day, region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  delete all.host; // fetch sets it
  return {...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
}

const sha256 = data => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as SigV4 requires.
const encode = text => encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const unescapeXml = text => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({lt: '<', gt: '>', quot: '"', apos: "'", amp: '&'})[e]);

async function storeError(res, operation) {
  const body = await res.text().catch(() => '');
  const code = body.match(/<Code>([^<]*)</)?.[1] ?? (res.status === 403 ? 'AccessDenied' : '');
  const message = body.match(/<Message>([^<]*)</)?.[1];
  const error = new Error(`S3 ${operation} failed with ${res.status}${code ? `: ${code}${message ? ` (${message})` : ''}` : ''}`);
  error.status = res.status;
  return error;
}
