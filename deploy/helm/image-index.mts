import {createHash} from 'node:crypto';

const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json';
const timeout = () => AbortSignal.timeout(30_000);

export async function registryToken(repository: string, credentials?: {user: string, password: string}) {
  const scope = credentials ? 'pull,push' : 'pull';
  const headers = new Headers();
  if (credentials) {
    const basic = Buffer.from(credentials.user + ':' + credentials.password).toString('base64');
    headers.set('Authorization', 'Basic ' + basic);
  }
  const response = await fetch('https://ghcr.io/token?service=ghcr.io&scope=repository:' + repository + ':' + scope, {
    headers, signal: timeout(), redirect: 'error',
  });
  if (!response.ok) throw Error('Cannot get registry token for ' + repository + ': HTTP ' + response.status);
  const {token} = await response.json();
  if (typeof token !== 'string' || !token) throw Error('Missing registry token for ' + repository);
  return token;
}

interface Index {bytes: Buffer; digest: string; mediaType: string}
export async function publicIndex(repository: string, tag: string): Promise<Index>;
export async function publicIndex(repository: string, tag: string, allowMissing: true): Promise<Index | null>;
export async function publicIndex(repository: string, tag: string, allowMissing = false): Promise<Index | null> {
  const token = await registryToken(repository);
  const response = await fetch('https://ghcr.io/v2/' + repository + '/manifests/' + tag, {
    headers: {authorization: 'Bearer ' + token, accept}, signal: timeout(), redirect: 'error',
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw Error(repository + ':' + tag + ' unavailable: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  if (response.headers.get('docker-content-digest') !== digest) throw Error('Registry manifest digest mismatch');
  const index = JSON.parse(bytes.toString());
  const platforms = index.manifests?.map((m: {platform?: {os: string, architecture: string}}) =>
    m.platform?.os + '/' + m.platform?.architecture) ?? [];
  for (const platform of ['linux/amd64', 'linux/arm64']) {
    if (!platforms.includes(platform)) throw Error(repository + ' lacks ' + platform);
  }
  const mediaType = index.mediaType ?? response.headers.get('content-type');
  if (!accept.split(', ').includes(mediaType)) throw Error('Unexpected registry index type for ' + repository);
  return {bytes, digest, mediaType};
}
