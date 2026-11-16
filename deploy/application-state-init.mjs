import {spawnSync} from 'node:child_process';
import './wait-storage.mjs';

// This one-shot service is the explicit initialization boundary for a fresh
// installation. Existing installations reach it only after the coordinated
// offline upgrade. The migrator refuses an incomplete or mismatched binding.
for (const operation of ['check', 'migrate', 'verify']) {
  const result = spawnSync(process.execPath, ['dist/src/state/migrate.mjs', operation], {stdio: 'inherit'});
  if (result.error || result.status !== 0) throw new Error(`Application state ${operation} failed; keep writers stopped and retain the migration recovery point.`);
}
