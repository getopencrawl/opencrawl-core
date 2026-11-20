import {startFileServer} from '../../../test/fixtures/shared-files-http.mjs';
const server = await startFileServer(process.argv[2]);
process.stdout.write(server.origin + '\n');
process.once('SIGTERM', async () => {await server.close();});
