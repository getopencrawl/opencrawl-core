import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, cp, writeFile, rm, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {root, validate, validateManifests} from '../scripts/validate.mjs';
const configs = await Promise.all(['plugin.json', '.claude-plugin/plugin.json', 'mcp.json', '.mcp.json'].map(async path => JSON.parse(await readFile(join(root, 'opencrawl', path)))));
test('both host manifests and allowlisted package are consistent', async () => {await validate();});
test('reject embedded credentials and local command transports', () => {
  for (const change of [s => {s.headers = {Authorization: 'Bearer forbidden'};}, s => {s.command = 'node';}]) {
    const copy = structuredClone(configs); change(copy[3].mcpServers.opencrawl);
    assert.throws(() => validateManifests(...copy));
  }
});
test('reject different resource audiences and no-auth downgrade', () => {
  for (const change of [s => {s.resource = 'https://other.example/mcp';}, s => {s.type = 'none';}]) {
    const copy = structuredClone(configs); change(copy[2].mcpServers.opencrawl.extensions['com.openai'].auth);
    assert.throws(() => validateManifests(...copy));
  }
});
test('reject unexpected files and symlink escapes', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'opencrawl-plugin-test-'));
  try {
    await cp(root + '/opencrawl', temp + '/opencrawl', {recursive: true});
    await writeFile(temp + '/opencrawl/.env', 'PRIVATE_VALUE=example');
    await assert.rejects(validate(temp), /Unexpected packaged file/);
    await rm(temp + '/opencrawl/.env');
    await rm(temp + '/opencrawl/README.md');
    await symlink('/etc/hosts', temp + '/opencrawl/README.md');
    await assert.rejects(validate(temp), /Symlink/);
  } finally {await rm(temp, {recursive: true, force: true});}
});

test('Cursor package rejects unexpected files, credential transports and blocking permission hooks', async()=>{
 const temp=await mkdtemp(join(tmpdir(),'opencrawl-cursor-plugin-'));
 const {validateCursor}=await import('../scripts/validate.mjs');
 try {
  await cp(root+'/opencrawl-cursor',temp+'/opencrawl-cursor',{recursive:true});
  await cp(root+'/.cursor-plugin',temp+'/.cursor-plugin',{recursive:true});
  await cp(root+'/LICENSE',temp+'/LICENSE');
  assert.equal(await validateCursor(temp),'0.1.0');
  const manifestPath=temp+'/opencrawl-cursor/.cursor-plugin/plugin.json',manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  await writeFile(manifestPath,JSON.stringify({...manifest,hooks:{preToolUse:[{command:'deny'}]}}));await assert.rejects(validateCursor(temp));await writeFile(manifestPath,JSON.stringify(manifest));
  const mcp=temp+'/opencrawl-cursor/mcp.json',original=await readFile(mcp,'utf8');
  await writeFile(mcp,JSON.stringify({mcpServers:{opencrawl:{url:'https://app.getopencrawl.com/mcp',headers:{Authorization:'forbidden'}}}}));await assert.rejects(validateCursor(temp));await writeFile(mcp,original);
  await writeFile(temp+'/opencrawl-cursor/.env','SECRET=never-package');await assert.rejects(validateCursor(temp),/Unexpected Cursor/);
 } finally {await rm(temp,{recursive:true,force:true});}
});
