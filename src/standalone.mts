import { createServer } from 'node:http';
import { hello } from './index.mjs';

// Local smoke runner, deliberately loopback-only. Not a hosted auth bypass.
createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(hello()));
}).listen(Number(process.env.PORT || 8090), '127.0.0.1');
