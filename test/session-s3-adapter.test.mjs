import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {signRequest, createObjectStore, awsCredentials} from '../dist/src/sessions/s3-store.mjs';

test('signs requests exactly like the AWS SigV4 reference example', () => {
  const headers = signRequest({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: {Range: 'bytes=0-9'},
    region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

/** Records S3 requests and answers from routes keyed by "METHOD host/path". */
function fakeS3(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({method: init.method || 'GET', url: u, headers: init.headers || {}});
    const route = routes[`${init.method || 'GET'} ${u.host}${u.pathname}`];
    return route ? route(u, init) : new Response('', {status: 200});
  };
  return {fetch, calls};
}

test('addresses AWS S3 virtual-hosted and S3-compatible stores path-style, signing session tokens', async () => {
  const {fetch, calls} = fakeS3();
  const credentials = {accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 'tok'};
  await createObjectStore({bucket: 'acme', region: 'eu-west-1', credentials, fetch}).put('a b/c.json', '{}');
  assert.equal(calls[0].url.href, 'https://acme.s3.eu-west-1.amazonaws.com/a%20b/c.json');
  assert.equal(calls[0].headers['x-amz-security-token'], 'tok');
  assert.match(calls[0].headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
  await createObjectStore({bucket: 'acme', endpoint: 'https://r2.example.com/', credentials, fetch}).get('k');
  assert.equal(calls[1].url.href, 'https://r2.example.com/acme/k');
});

test('reports a missing bucket clearly and never creates one', async () => {
  const {fetch, calls} = fakeS3({'HEAD acme.s3.us-east-1.amazonaws.com/': () => new Response('', {status: 404})});
  const store = createObjectStore({bucket: 'acme', credentials: {accessKeyId: 'a', secretAccessKey: 's'}, fetch});
  await assert.rejects(store.checkAccess(), /S3 bucket acme does not exist/);
  assert.deepEqual(calls.map(c => c.method), ['HEAD']);
  const denied = fakeS3({'HEAD acme.s3.us-east-1.amazonaws.com/': () => new Response('', {status: 403})});
  await assert.rejects(createObjectStore({bucket: 'acme', credentials: {accessKeyId: 'a', secretAccessKey: 's'}, fetch: denied.fetch}).checkAccess(), /403: AccessDenied/);
});

test('finds AWS credentials from the environment, containers, web identity and instance roles', async t => {
  const keys = await awsCredentials({env: {AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't'}})();
  assert.deepEqual(keys, {accessKeyId: 'AKIA', secretAccessKey: 's', sessionToken: 't'});

  const expiration = new Date(Date.now() + 3600_000).toISOString();
  const role = {AccessKeyId: 'ASIA', SecretAccessKey: 's', Token: 't', Expiration: expiration};
  const ecs = fakeS3({'GET 169.254.170.2/v2/credentials/x': () => Response.json(role)});
  assert.equal((await awsCredentials({env: {AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/x'}, fetch: ecs.fetch})()).sessionToken, 't');

  const dir = await mkdtemp(join(tmpdir(), 'oc-irsa-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  await writeFile(join(dir, 'token'), 'jwt\n');
  const sts = fakeS3({'GET sts.eu-west-1.amazonaws.com/': u => {
    assert.equal(u.searchParams.get('WebIdentityToken'), 'jwt');
    return new Response(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIA2</AccessKeyId>
      <SecretAccessKey>s2</SecretAccessKey><SessionToken>t2</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
  }});
  const irsa = await awsCredentials({env: {AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, 'token'), AWS_ROLE_ARN: 'arn:aws:iam::1:role/r', AWS_REGION: 'eu-west-1'}, fetch: sts.fetch})();
  assert.deepEqual([irsa.accessKeyId, irsa.sessionToken], ['ASIA2', 't2']);

  let fetched = 0;
  const imds = fakeS3({
    'PUT 169.254.169.254/latest/api/token': () => new Response('imds-token'),
    'GET 169.254.169.254/latest/meta-data/iam/security-credentials/': () => new Response('opencrawl-role\n'),
    'GET 169.254.169.254/latest/meta-data/iam/security-credentials/opencrawl-role': () => (fetched++, Response.json({...role, Expiration: new Date(Date.now() + 60_000).toISOString()})),
  });
  const instance = awsCredentials({env: {}, fetch: imds.fetch});
  assert.equal((await instance()).accessKeyId, 'ASIA');
  assert.equal(imds.calls[1].headers['X-aws-ec2-metadata-token'], 'imds-token');
  await instance();
  assert.equal(fetched, 2, 'credentials within five minutes of expiry are refreshed');

  const none = fakeS3({'PUT 169.254.169.254/latest/api/token': () => { throw new Error('no route'); }});
  await assert.rejects(awsCredentials({env: {}, fetch: none.fetch})(), /No S3 credentials/);
});
