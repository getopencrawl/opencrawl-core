import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import './wait-storage.mjs';

// This one-shot service creates the application-state schema on a fresh
// installation and is a no-op afterwards. Writers start only after it verifies.
const leftover = process.env.OPENCRAWL_IDENTITY_PATH || '/data/identity.sqlite';
if (existsSync(leftover)) console.warn(`WARNING: ${leftover} is from a pre-PostgreSQL release and is ignored. There is no upgrade path; this installation starts empty.`);
for (const command of ['initialize', 'verify']) {
  const result = spawnSync(process.execPath, ['dist/src/state/initialize.mjs', command], {stdio: 'inherit'});
  if (result.error || result.status !== 0) throw new Error(`Application state ${command} failed; writers stay stopped.`);
}
