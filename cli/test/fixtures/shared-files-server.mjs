import {startFileServer} from '../../../test/fixtures/shared-files-http.mjs';
import {fileRepositories} from '../../../dist/src/files/store.mjs';
const store = fileRepositories(process.argv[2], 'files-test');
const original = store.open;
store.open = async tenant => {
  try { return await original(tenant); }
  catch (error) { console.error('Could not open the fixture repository:', error); throw error; }
};
const server = await startFileServer(process.argv[2], {store});
process.stdout.write(server.origin + '\n');
process.once('SIGTERM', async () => {await server.close();});
