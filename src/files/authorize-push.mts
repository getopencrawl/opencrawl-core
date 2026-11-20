// Invoked only by the service-owned native Git hook. No CLI or user credentials.
import {request} from 'node:http';
const check = request(process.env.OPENCRAWL_GIT_CHECK!, {method: 'POST', agent: false}, (res) => {
  if (res.statusCode === 507) process.stderr.write('Shared Git storage quota or volume reserve reached.\n');
  res.resume();
  process.exitCode = res.statusCode === 204 ? 0 : 1;
});
check.on('error', () => {
  process.exitCode = 1;
});
check.end();
