import {setTimeout} from 'node:timers/promises';
import {sessionStorage} from '../dist/src/sessions/storage.mjs';

// No source writes: wait for the bundled S3 service to create its configured
// bucket, using the same signed access check as the application startup.
const {store} = sessionStorage(process.env);
const deadline = Date.now() + 90000;
for (;;) {
  try {await store.checkAccess(); break;}
  catch (error) {if (Date.now() >= deadline) throw error;}
  await setTimeout(1000);
}
