import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {once} from 'node:events';
import {readFile, writeFile} from 'node:fs/promises';
import tls from 'node:tls';

const [output] = process.argv.slice(2);
const proofRoot = '/candidate/usr/share/opencrawl-node-runtime';
const patched = JSON.parse(await readFile(`${proofRoot}/patched.json`, 'utf8'));
const native = JSON.parse(await readFile('/proof/al2023-native.json', 'utf8'));
const abi = JSON.parse(await readFile(`${proofRoot}/elf-abi.json`, 'utf8'));
const binarySha256 = createHash('sha256').update(await readFile(process.execPath)).digest('hex');
assert.equal(binarySha256, patched.binarySha256);
assert.equal(binarySha256, native.binarySha256);
assert.equal(binarySha256, abi.node.sha256);
assert.equal(native.result.inputReset, true);
assert.equal(native.result.externalBufferRetained, false);
assert.equal(native.result.followupBytes, Buffer.byteLength('synthetic follow-up'));
assert.equal(process.version, 'v24.22.2');
assert(['x64', 'arm64'].includes(process.arch));
const release = await readFile('/etc/os-release', 'utf8');
assert.match(release, /^ID="?amzn"?$/m);
assert.match(release, /^VERSION_ID="?2023"?$/m);
const glibcVersionRuntime = process.report.getReport().header.glibcVersionRuntime;
assert.equal(glibcVersionRuntime, '2.34');
assert(tls.rootCertificates.length > 0, 'Built-in public trust roots remain present');
assert.equal(randomBytes(32).length, 32);
const answers = await lookup('localhost', {all: true});
assert(answers.length && answers.every(({address}) => ['127.0.0.1', '::1'].includes(address)));

// Real TLS negotiation and CA/name verification on loopback. These temporary
// keys stay in the disposable test stage; the exported artifact contains none.
const key = await readFile('/proof/localhost.key');
const cert = await readFile('/proof/localhost.crt');
const server = tls.createServer({key, cert, minVersion: 'TLSv1.2'}, socket => socket.end('al2023-native-ok'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let socket, tlsVersion;
try {
  socket = tls.connect({host: '127.0.0.1', port: server.address().port,
    servername: 'localhost', ca: cert, rejectUnauthorized: true, minVersion: 'TLSv1.2'});
  socket.setTimeout(5000, () => socket.destroy(new Error('Local TLS probe timed out')));
  await once(socket, 'secureConnect');
  assert.equal(socket.authorized, true);
  tlsVersion = socket.getProtocol();
  assert(['TLSv1.2', 'TLSv1.3'].includes(tlsVersion));
  const chunks = [];
  for await (const chunk of socket) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'al2023-native-ok');
} finally {
  socket?.destroy();
  await new Promise(resolve => server.close(resolve));
}
const proof = {version: 1, scope: 'native AL2023 container userland, not host boot/systemd',
  binarySha256, architecture: process.arch, nodeVersion: process.version,
  glibcVersionRuntime, nativeModuleAbi: process.versions.modules,
  nativeGzWriteRegression: native.result, dnsLocalhost: true,
  verifiedLocalTls: tlsVersion, publicTrustRoots: tls.rootCertificates.length,
  operatingSystemImage: 'amazonlinux:2023@sha256:3ccfbe800f864982b0a4e124a614b2382518cbd04b3c1cd35202bd46f392675b'};
await writeFile(output, JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof));
