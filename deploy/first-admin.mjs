// Run inside the app container. Only loopback receives the bootstrap grant.
import {readFileSync} from 'node:fs';

const origin = new URL(process.env.OPENCRAWL_URL).origin;
const local = 'http://127.0.0.1:8092';
const email = 'admin@opencrawl.local';
const password = readFileSync(0, 'utf8').trim();
if (!/^[a-f0-9]{48}$/.test(password)) throw new Error('Invalid first-admin password file.');
const post = (path, fields) => fetch(local + path, {
  method: 'POST', redirect: 'manual', headers: {origin}, body: new URLSearchParams(fields),
});
const signup = await post('/auth/signup', {
  setup: process.env.OPENCRAWL_SETUP_TOKEN, name: 'Administrator', workspace: 'OpenCrawl', email, password,
});
// An interrupted installation can resume after account creation.
if (signup.status !== 303 && signup.status !== 403 && signup.status !== 409)
  throw new Error('First-admin signup returned HTTP ' + signup.status);
const login = await post('/auth/login', {email, password});
if (login.status !== 303) throw new Error('First-admin login failed. Existing accounts were preserved.');
const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
const access = await fetch(local + '/api/keys', {headers: {cookie}, redirect: 'manual'});
if (!access.ok) throw new Error('Could not verify administrator access.');
console.log(JSON.stringify({url: origin + '/auth/login', email, password}));
