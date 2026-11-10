import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectorManifest} from '../dist/src/integrations/manifests.mjs';

const run=promisify(execFile);
const pin=JSON.parse(await readFile(new URL('../dev/pins.json',import.meta.url),'utf8')).declarative;

test('the development Airbyte and the GitHub connector image pin the same declarative runtime',async()=>{
  const from=/^FROM airbyte\/source-declarative-manifest:(\S+)@(sha256:[a-f0-9]{64})$/m.exec(await readFile(new URL('../connectors/github/Dockerfile',import.meta.url),'utf8'));
  assert.ok(from,'the GitHub connector image pins the declarative runtime by digest');
  assert.deepEqual(pin,{version:from[1],imageSha:from[2]});
});

// Airbyte validates a manifest only when it builds the streams, so a component the runtime does not know
// surfaces as a failed connection setup. Discovery here reads no provider data and needs no network.
test('real runtime image: every connector manifest passes discovery on the pinned declarative runtime',{skip:!process.env.OPENCRAWL_TEST_CONNECTOR_RUNTIME},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'opencrawl-connector-runtime-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const image=`airbyte/source-declarative-manifest:${pin.version}@${pin.imageSha}`;
  for(const id of ['slack','googledrive','notion','circleback','granola']){
    const manifest=connectorManifest(id),spec=manifest.spec.connection_specification,config={__injected_declarative_manifest:manifest};
    for(const key of spec.required)config[key]=key==='start_date'?'2026-01-01T00:00:00Z':key==='connected_account_id'?'ca_placeholder':spec.properties[key].type==='integer'?1:'placeholder';
    const file=join(dir,id+'.json');await writeFile(file,JSON.stringify(config));await chmod(file,0o644);
    const result=await run('docker',['run','--rm','--network','none','-v',`${file}:/config.json:ro`,image,'discover','--config','/config.json'],{maxBuffer:64*1024*1024}).catch(error=>error);
    const messages=String(result.stdout||'').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const refused=messages.find(message=>message.type==='TRACE'&&message.trace?.error)?.trace.error.message;
    assert.ok(messages.some(message=>message.type==='CATALOG'&&message.catalog.streams.length),`${id} does not load on declarative runtime ${pin.version}: ${refused||String(result.stderr||result.message||'no catalog').slice(0,400)}`);
  }
});
