import {createHash, randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';

const [name, origin, destination] = process.argv.slice(2);
if (process.argv.length !== 5 || !/^[a-z][a-z0-9-]{0,47}$/.test(name)) {
  throw Error('Usage: node machine-key.mjs SERVICE-NAME SELF-HOST-ORIGIN NEW-ENV-FILE');
}
const url = new URL(origin);
if (url.origin !== origin || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
  throw Error('Use the exact HTTPS origin of your installation, or local HTTP on loopback');
}
// The output can be sourced by a POSIX shell. Reject any non-shell-safe authority.
if (!/^[a-zA-Z0-9.:[\]-]+$/.test(url.host)) throw Error('Invalid self-host authority');
const key = 'oca1_' + randomBytes(32).toString('hex');
writeFileSync(destination, `OPENCRAWL_API_URL=${origin}\nOPENCRAWL_TOKEN=${key}\nOPENCRAWL_SESSIONS_TOKEN=${key}\n`, {flag: 'wx', mode: 0o600});
console.log(name + ':' + createHash('sha256').update(key).digest('hex'));
