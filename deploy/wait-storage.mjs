import {setTimeout} from 'node:timers/promises';
import {standaloneStorage} from '../dist/src/sessions/standalone.mjs';

// No source writes: wait for the bundled S3 service to create its configured
// bucket, using the same signed access check as the application startup.
const {store} = standaloneStorage(process.env);
const deadline = Date.now() + 90000;
for (;;) {
  try {await store.checkAccess(); break;}
  catch (error) {if (Date.now() >= deadline) throw error;}
  await setTimeout(1000);
}
