import {createHash} from 'node:crypto';
import {appendFileSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

// PR merge SHAs differ from the final main SHA, including for squash merges.
// Compare every distributed file. Only the verified Git revision field and tar
// timestamps differ legitimately. The main publisher always uses its own build.
export async function releasePayload(root: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full source revision');
  const entries: [string, string, number][] = [];
  function add(name: string, bytes: Uint8Array, mode = 0) {
    if (name.endsWith('/package.json')) {
      const pkg = JSON.parse(Buffer.from(bytes).toString());
      if (pkg.opencrawlRevision !== revision) throw new Error('Unexpected source in ' + name);
      delete pkg.opencrawlRevision;
      entries.push([name, hash(JSON.stringify(pkg)), mode]);
    } else entries.push([name, hash(bytes), mode]);
  }
  function visit(path: string) {
    for (const item of readdirSync(join(root,path), {withFileTypes:true})) {
      const name = path+'/'+item.name;
      if (item.isDirectory()) visit(name);
      else if (item.isFile()) add(name,readFileSync(join(root,name)),statSync(join(root,name)).mode & 0o111);
      else throw new Error('Unexpected release entry: '+name);
    }
  }
  visit('dist');
  for (const name of readdirSync(join(root,'native'))) {
    if (name.endsWith('.tgz')) {
      const archive = await new Bun.Archive(readFileSync(join(root,'native',name))).files();
      for (const [path,file] of archive) add('native/'+name+'/'+path,new Uint8Array(await file.arrayBuffer()));
    } else if (name==='install.sh'||name==='install.ps1') add('native/'+name,readFileSync(join(root,'native',name)));
    else if (name!=='SHA256SUMS'&&name!=='release.json') throw new Error('Unexpected native file: '+name);
  }
  return hash(JSON.stringify(entries.sort(([a],[b])=>a<b?-1:a>b?1:0)));
}

if (import.meta.main) {
  const payload=await releasePayload(join(import.meta.dir,'..'),process.env.GITHUB_SHA!);
  appendFileSync(process.env.GITHUB_OUTPUT!, 'payload='+payload+'\n');
}
