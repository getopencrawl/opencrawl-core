import {test,expect} from 'bun:test';
import {gunzipSync} from 'node:zlib';
import {nativeArchive} from '../scripts/native-archive.ts';

test('native downloads are gzip archives containing the exact executable and support bytes',async()=>{
  const entries={
    'package/bin/opencrawl':new Uint8Array([0,255,17,0,42]),
    'package/runtime/opencrawl.js':new TextEncoder().encode('console.log("runtime");'),
    'package/LICENSE':new TextEncoder().encode('License notice'),
  };
  const downloaded=await nativeArchive(entries);
  // GNU tar -z requires actual gzip; BSD tar's autodetection hid this defect.
  const tar=gunzipSync(downloaded),files=await new Bun.Archive(tar).files();
  expect([...files.keys()].sort()).toEqual(Object.keys(entries).sort());
  for(const [path,expected] of Object.entries(entries))expect(await files.get(path)!.bytes()).toEqual(expected);
});
