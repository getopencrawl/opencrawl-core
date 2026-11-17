import {spawnSync} from 'node:child_process';
import './wait-storage.mjs';

// This one-shot service creates the application-state schema on a fresh
// installation and is a no-op afterwards. Writers start only after it verifies.
for (const command of ['initialize', 'verify']) {
  const result = spawnSync(process.execPath, ['dist/src/state/initialize.mjs', command], {stdio: 'inherit'});
  if (result.error || result.status !== 0) throw new Error(`Application state ${command} failed; writers stay stopped.`);
}
