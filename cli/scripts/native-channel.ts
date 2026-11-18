import {execFileSync, spawnSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {createRequire} from 'node:module';
import {parseNativeRelease, type NativeRelease} from '../src/native-channel.ts';

const repo = 'repos/getopencrawl/opencrawl-core';
const ref = 'heads/cli-stable';
const {compare} = createRequire(import.meta.url)('../bin/opencrawl.cjs');

function github(path: string, body?: object, method = 'POST') {
  const args = ['api', repo + '/' + path];
  if (body) args.push('-X', method, '--input', '-');
  return JSON.parse(execFileSync('gh', args, {input: body ? JSON.stringify(body) : undefined, encoding: 'utf8'}));
}

// The branch contains only release.json. A non-forced ref update atomically
// advertises all platforms and rejects a competing writer on a different parent.
export function promoteNative(release: NativeRelease) {
  parseNativeRelease(release);
  const head = spawnSync('gh', ['api', repo + '/git/ref/' + ref], {encoding: 'utf8'});
  let parent: string | undefined;
  if (head.status === 0) {
    parent = JSON.parse(head.stdout).object.sha;
    const file = github('contents/release.json?ref=' + parent);
    const previous = parseNativeRelease(JSON.parse(Buffer.from(file.content, 'base64').toString()));
    if (compare(previous.version, release.version) > 0) throw new Error('Refusing to downgrade native CLI');
    if (previous.version === release.version) {
      if (!isDeepStrictEqual(previous, release)) throw new Error('Native release identity or checksums changed');
      return;
    }
    const comparison = repo+'/compare/'+previous.revision+'...'+release.revision+'?per_page=1';
    const status = execFileSync('gh',['api',comparison,'--jq','.status'],{encoding:'utf8'}).trim();
    if (status !== 'ahead' && status !== 'identical') throw new Error('Refusing to replace native CLI with older or divergent source');
  } else if (!head.stderr.includes('HTTP 404')) throw new Error('Could not read native release channel: ' + head.stderr);
  const tree = github('git/trees', {tree: [{path: 'release.json', mode: '100644', type: 'blob', content: JSON.stringify(release, null, 2) + '\n'}]});
  const commit = github('git/commits', {message: 'Release native CLI ' + release.version, tree: tree.sha, parents: parent ? [parent] : []});
  if (parent) github('git/refs/' + ref, {sha: commit.sha, force: false}, 'PATCH');
  else github('git/refs', {ref: 'refs/' + ref, sha: commit.sha});
  console.log('Promoted native CLI ' + release.version + ' from ' + release.revision);
}
