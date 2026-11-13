import type {AwsCredentials, CredentialProvider, ListOptions, ReadOptions, ServiceError, StoreVersion, ObjectStore} from './types.mjs';
import {serviceError} from './types.mjs';
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
export function createObjectStore({endpoint, region = 'us-east-1', bucket, credentials, fetch: fetchImpl = globalThis.fetch}: {endpoint?: string; region?: string; bucket: string; credentials: AwsCredentials | CredentialProvider; fetch?: typeof globalThis.fetch}) {
  if (!bucket) throw new Error('S3 bucket is required');
  if (!credentials) throw new Error('S3 credentials are required');
  const resolve = typeof credentials === 'function' ? credentials : async () => credentials;
  const root = endpoint
    ? `${endpoint.replace(/\/+$/, '')}/${bucket}`
    : bucket.includes('.') ? `https://s3.${region}.amazonaws.com/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;

  async function request(method: string, key?: string, {query = {}, body, headers = {}}: {query?: Record<string, string | null | undefined>; body?: Uint8Array; headers?: Record<string, string>} = {}) {
    let url, signed;
    try {
      url = new URL(`${root}/${key === undefined ? '' : key.split('/').map(encode).join('/')}`);
      for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(name, value);
      const {accessKeyId, secretAccessKey, sessionToken} = await resolve();
      signed = signRequest({
        method, url, body, region, accessKeyId, secretAccessKey,
        headers: sessionToken ? {...headers, 'x-amz-security-token': sessionToken} : headers,
      });
    } catch(caught){const error=serviceError(caught);throw Object.assign(serviceError(error), method === 'PUT' ? {writeOutcome: 'not-applied'} : {});}
    // A signed request is bound to this origin. In particular, fetch retains the
    // security-token header on cross-origin redirects even when it strips Authorization.
    const res = await fetchImpl(url, {method, headers: signed, body: body as BodyInit | undefined, redirect: 'error'});
    if (!res.ok && !(res.status === 404 && method !== 'PUT')) {
      const error = await storeError(res, `${method} ${key ?? bucket}`);
      // One atomic PutObject was positively refused. Do not generalize to
      // transport failures, server errors, or arbitrary S3-compatible responses.
      if (method === 'PUT' && ([401, 403].includes(res.status) && ['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken', 'TokenRefreshRequired', 'RequestTimeTooSkewed'].includes(error.code ?? '') ||
          res.status === 412 && error.code === 'PreconditionFailed' ||
          res.status === 400 && ['BadDigest', 'InvalidDigest', 'InvalidArgument', 'InvalidRequest', 'EntityTooLarge', 'AuthorizationHeaderMalformed'].includes(error.code ?? '') ||
          res.status === 404 && error.code === 'NoSuchBucket' ||
          res.status === 409 && error.code === 'ConditionalRequestConflict')) error.writeOutcome = 'not-applied';
      throw error;
    }
    return res;
  }

  async function listPage(prefix: string, {delimiter, continuationToken, maxKeys=1000}: ListOptions = {}) {
    if(!Number.isInteger(maxKeys)||maxKeys<1||maxKeys>1000)throw new Error('Invalid S3 page size');
    const res=await request('GET',undefined,{query:{'list-type':'2',prefix,delimiter,'continuation-token':continuationToken,'max-keys':String(maxKeys)}});
    if(res.status===404)throw await storeError(res, `LIST ${bucket}`);
    const xml=await res.text();
    const keys=[...xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>/g)].map(m=>unescapeXml(m[1]));
    const prefixes=[...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]*)<\/Prefix>/g)].map(m=>unescapeXml(m[1]));
    // Cycle detection retains cursors for the scan. Copy the token so a V8
    // substring cannot keep this entire XML response alive with it.
    const nextToken=/<IsTruncated>true<\/IsTruncated>/.test(xml)?Buffer.from(unescapeXml(xml.match(/<NextContinuationToken>([^<]*)</)?.[1]??''),'utf8').toString('utf8'):null;
    if(nextToken==='')throw new Error('S3 listing omitted its continuation token');
    if(nextToken&&nextToken===continuationToken)throw new Error('S3 listing repeated its continuation token');
    return {keys,prefixes,nextToken};
  }

  return {
    bucket,
    listPage,
    location: endpoint ? `${endpoint} bucket ${bucket}` : `s3://${bucket} (${region})`,

    /** Confirms the bucket exists and these credentials can reach it. Never creates a bucket. */
    async checkAccess() {
      const res = await request('HEAD');
      if (res.status === 404) throw new Error(`S3 bucket ${bucket} does not exist. Create it, or fix OPENCRAWL_LANDING_S3_BUCKET.`);
    },

    put: (key: string, body: Uint8Array, contentType = 'application/octet-stream') =>
      request('PUT', key, {body, headers: {'content-type': contentType}}).then(() => undefined),

    /** Check immutable objects without transferring their bodies. */
    async has(key: string, {maxBytes}: ReadOptions = {}) {
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid object read limit');
      const res = await request('HEAD', key);
      if (res.status === 404) return false;
      if (maxBytes !== undefined && Number(res.headers.get('content-length')) > maxBytes) {
        throw Object.assign(new Error('Object exceeds read limit'), {permanent: true});
      }
      return true;
    },

    // Conditional documents: a failed comparison must never overwrite a peer's write.
    async readVersion(key: string, {maxBytes = 16 * 1024 * 1024}: ReadOptions = {}) {
      const res = await request('GET', key);
      if (res.status === 404) return {version: null, data: null};
      const version = res.headers.get('etag');
      if (!version) {await res.body?.cancel(); throw new Error('Object store omitted ETag');}
      const parts = []; let size = 0;
      for await (const part of res.body!) {
        size += part.length;
        if (size > maxBytes) {throw new Error('Object exceeds read limit');}
        parts.push(part);
      }
      return {version, data: Buffer.concat(parts)};
    },
    async compareAndSet(key: string, version: StoreVersion | null, data: Uint8Array) {
      try {
        await request('PUT', key, {body: data, headers: {'content-type': 'application/json',
          ...(version === null ? {'if-none-match': '*'} : {'if-match': String(version)})}});
        return true;
      } catch(caught){const error=serviceError(caught);if ([409, 412].includes(error.status ?? 0)) return false; throw error;}
    },

    /** Returns the object as a Buffer, or null if it does not exist. */
    async get(key: string, {maxBytes}: ReadOptions = {}) {
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error('Invalid object read limit');
      const res = await request('GET', key);
      if (res.status === 404) return null;
      if (maxBytes === undefined) return Buffer.from(await res.arrayBuffer());
      if (Number(res.headers.get('content-length')) > maxBytes) {
        await res.body?.cancel();
        throw Object.assign(new Error('Object exceeds read limit'), {permanent: true});
      }
      const parts = []; let size = 0;
      for await (const part of res.body!) {
        size += part.length;
        if (size > maxBytes) throw Object.assign(new Error('Object exceeds read limit'), {permanent: true});
        parts.push(part);
      }
      return Buffer.concat(parts);
    },

    delete: (key: string) => request('DELETE', key).then(() => undefined),

    async purgePrefix(prefix: string, {select = () => true, selectVersion, beforeDelete}: Parameters<NonNullable<ObjectStore['purgePrefix']>>[1] = {}) {
      if (!prefix || prefix.includes('..')) throw new Error('Explicit purge prefix required');
      async function inventory(keyMarker?: string, versionMarker?: string) {
        const res = await request('GET', undefined, {query: {versions: '', prefix, 'max-keys': '1000',
          'key-marker': keyMarker, 'version-id-marker': versionMarker}});
        if (!res.ok) throw await storeError(res, 'LIST VERSIONS');
        const xml = await res.text();
        if (!/<ListVersionsResult(?:\s|>)/.test(xml) || !/<IsTruncated>(true|false)<\/IsTruncated>/.test(xml)) throw new Error('Invalid S3 version inventory');
        const entries = [...xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)].map(match => {
          const key = unescapeXml(match[2].match(/<Key>([^<]*)<\/Key>/)?.[1] ?? '');
          const version = unescapeXml(match[2].match(/<VersionId>([^<]*)<\/VersionId>/)?.[1] ?? '');
          if (!key.startsWith(prefix) || !version) throw new Error('Invalid S3 version scope');
          return {key, version, marker: match[1] === 'DeleteMarker'};
        });
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        const nextKey = unescapeXml(xml.match(/<NextKeyMarker>([^<]*)</)?.[1] ?? '');
        const nextVersion = unescapeXml(xml.match(/<NextVersionIdMarker>([^<]*)</)?.[1] ?? '');
        if (truncated && !nextKey) throw new Error('S3 version inventory omitted cursor');
        return {entries, truncated, nextKey, nextVersion};
      }
      // Each sweep verifies both complete pagination and scope. Repeat the first
      // sweep after deletion to prove no selected version remains.
      let removed = 0;
      for (let pass = 0; pass < 2; pass++) {
        let keyMarker: string | undefined, versionMarker: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await inventory(keyMarker, versionMarker);
          for (const item of page.entries) {
            if (!select(item.key)) continue;
            let cached: Buffer | undefined;
            const read = async () => {
              if (cached) return cached;
              const res = await request('GET', item.key, {query: {versionId: item.version}});
              if (!res.ok) throw await storeError(res, 'READ VERSION');
              const parts: Uint8Array[] = []; let size = 0;
              for await (const part of res.body!) {size += part.length; if (size > 256 * 1024 * 1024) throw new Error('Purge source exceeds limit'); parts.push(part);}
              return cached = Buffer.concat(parts);
            };
            if (selectVersion && (item.marker || !await selectVersion(item.key, read))) continue;
            if (pass) throw new Error('Raw session versions remain after deletion');
            if (beforeDelete && !item.marker) await beforeDelete(item.key, read);
            await request('DELETE', item.key, {query: {versionId: item.version}});
            removed++;
          }
          if (!page.truncated) break;
          const token = JSON.stringify([page.nextKey, page.nextVersion]);
          if (seen.has(token)) throw new Error('S3 version inventory cursor did not advance');
          seen.add(token); keyMarker = page.nextKey; versionMarker = page.nextVersion;
        } while (true);
      }
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await listPage(prefix, {continuationToken: cursor});
        for (const key of page.keys) {
          if (!key.startsWith(prefix)) throw new Error('Purge verification outside scope');
          if (select(key) && (!selectVersion || await selectVersion(key, async () => {
            const res = await request('GET', key);
            if (!res.ok) throw await storeError(res, 'VERIFY PURGE');
            const parts:Uint8Array[]=[];let size=0;
            for await(const part of res.body!){size+=part.length;if(size>256*1024*1024)throw new Error('Purge verification exceeds limit');parts.push(part);}
            return Buffer.concat(parts);
          }))) throw new Error('Raw objects remain after version deletion');
        }
        cursor = page.nextToken;
        if (cursor) {if (seen.has(cursor)) throw new Error('Purge verification cursor did not advance'); seen.add(cursor);}
      } while (cursor);
      return removed;
    },

    /** Bounded streaming reads for connector files; closes the response on error/cancellation. */
    async *read(key: string, {maxBytes = 256 * 1024 * 1024}: ReadOptions = {}) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid object read limit');
      const res = await request('GET', key);
      if (res.status === 404) throw new Error('Source object is not available');
      if (Number(res.headers.get('content-length')) > maxBytes) {
        await res.body?.cancel();
        throw Object.assign(new Error('Object exceeds read limit'), {permanent: true});
      }
      let size = 0;
      for await (const chunk of res.body!) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error('Object exceeds read limit'), {permanent: true});
        yield chunk;
      }
    },

    /** Lists keys under prefix. With delimiter '/', returns direct children only, plus subdirectory prefixes. */
    async list(prefix: string, {delimiter}: {delimiter?: string} = {}) {
      const keys = [];
      const prefixes = [];
      const seen = new Set();
      let token: string | null | undefined;
      do {
        const page = await listPage(prefix, {delimiter, continuationToken: token});
        keys.push(...page.keys); prefixes.push(...page.prefixes);
        token = page.nextToken;
        if (token && seen.has(token)) throw new Error('S3 listing repeated its continuation token');
        if (token) seen.add(token);
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
  let cached: AwsCredentials | null = null;
  return async () => {
    if (cached && (!cached.expiration || cached.expiration - Date.now() > 5 * 60_000)) return cached;
    cached = await loadCredentials(env, fetchImpl);
    return cached;
  };
}

async function loadCredentials(env: NodeJS.ProcessEnv, fetchImpl: typeof globalThis.fetch): Promise<AwsCredentials> {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN};
  }
  const temporary = (c: {AccessKeyId?: string; SecretAccessKey?: string; Token?: string; SessionToken?: string; Expiration?: string}): AwsCredentials => ({
    accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.Token ?? c.SessionToken,
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
    const field = (name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
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
export function signRequest({method, url, headers = {}, body, region, accessKeyId, secretAccessKey, service = 's3', date = new Date()}: {method: string; url: URL; headers?: Record<string, string>; body?: string | Uint8Array; region: string; accessKeyId: string; secretAccessKey: string; service?: string; date?: Date}) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all: Record<string, string> = {
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
  // S3 signs its already encoded object path; other services URI-encode it again.
  const canonicalPath = service === 's3' ? url.pathname : url.pathname.split('/').map(encode).join('/');
  const canonical = [method, canonicalPath, query, ...names.map(name => `${name}:${all[name]}`), '', names.join(';'), all['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let key: string | Buffer = `AWS4${secretAccessKey}`;
  for (const part of [day, region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  delete all.host; // fetch sets it
  return {...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`};
}

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, as SigV4 requires.
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const unescapeXml = (text: string) => text.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({lt: '<', gt: '>', quot: '"', apos: "'", amp: '&'} as Record<string, string>)[e]);

async function storeError(res: Response, operation: string) {
  const body = await res.text().catch(() => '');
  const code = body.match(/<Code>([^<]*)</)?.[1] ?? (res.status === 403 ? 'AccessDenied' : '');
  const message = body.match(/<Message>([^<]*)</)?.[1];
  const error: ServiceError = new Error(`S3 ${operation} failed with ${res.status}${code ? `: ${code}${message ? ` (${message})` : ''}` : ''}`);
  error.status = res.status;
  error.code = body.match(/<Code>([^<]*)</)?.[1];
  return error;
}
