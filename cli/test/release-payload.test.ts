import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releasePayload} from '../scripts/release-payload.ts';

test('candidate identity covers the native archive bytes and permits only the source stamp to change', async () => {
  const root=mkdtempSync(join(tmpdir(),'opencrawl-release-proof-'));
  mkdirSync(join(root,'dist/cli'),{recursive:true});
  mkdirSync(join(root,'native'));
  async function build(revision:string, executable:string) {
    const manifest=JSON.stringify({name:'fixture',version:'1.0.0',opencrawlRevision:revision});
    writeFileSync(join(root,'dist/cli/package.json'),manifest);
    const archive=new Bun.Archive({'package/package.json':manifest,'package/bin/opencrawl':executable},{compress:'gzip'});
    writeFileSync(join(root,'native/opencrawl-linux-x64.tgz'),await archive.bytes());
    return releasePayload(root,revision);
  }
  try {
    const candidate=await build('a'.repeat(40),'same executable');
    expect(await build('b'.repeat(40),'same executable')).toBe(candidate);
    expect(await build('b'.repeat(40),'different executable')).not.toBe(candidate);
    await expect(releasePayload(root,'a'.repeat(40))).rejects.toThrow('source');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
