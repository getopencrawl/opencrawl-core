import {readFileSync} from 'node:fs';
import {publicIndex, registryToken} from './image-index.mts';
import {versionParts} from './release.mts';

export async function tagStableImages(version: string, revision: string, credentials: {user: string, password: string}) {
  versionParts(version);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('Expected an immutable source revision');
  const repositories = ['getopencrawl/opencrawl-core', 'getopencrawl/source-github'];
  const images = await Promise.all(repositories.map(async repository => {
    const source = await publicIndex(repository, 'sha-' + revision);
    const existing = await publicIndex(repository, version, true);
    if (existing && existing.digest !== source.digest) throw Error(repository + ':' + version + ' already references a different image');
    return {repository, source, existing};
  }));
  for (const {repository, source, existing} of images) {
    if (!existing) {
      const token = await registryToken(repository, credentials);
      const response = await fetch('https://ghcr.io/v2/' + repository + '/manifests/' + version, {
        method: 'PUT',
        headers: {authorization: 'Bearer ' + token, 'content-type': source.mediaType},
        body: new Uint8Array(source.bytes),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!response.ok) throw Error('Cannot publish ' + repository + ':' + version + ': HTTP ' + response.status);
    }
    const published = await publicIndex(repository, version);
    if (published.digest !== source.digest) throw Error('Stable tag digest mismatch: ' + repository);
    console.log(repository + ':' + version + ' ' + published.digest);
  }
}

if (import.meta.main) {
  const {GH_TOKEN, GITHUB_ACTOR, REVISION} = process.env;
  if (!GH_TOKEN || !GITHUB_ACTOR || !REVISION) throw Error('Stable release workflow context required');
  const {version} = JSON.parse(readFileSync('package.json', 'utf8'));
  await tagStableImages(version, REVISION, {user: GITHUB_ACTOR, password: GH_TOKEN});
}
