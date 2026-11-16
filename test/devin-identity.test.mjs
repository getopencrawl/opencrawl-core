import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair, SignJWT} from 'jose';
import {createDevinVerifier, createDevinWorkloads, devinOwnerId, isDevinToken, DEVIN_ISSUER} from '../dist/src/identity/devin.mjs';

const org = 'org-11111111111141118111111111111111', otherOrg = 'org-22222222222242228222222222222222';
const audience = 'https://operator.example', session = 'devin-33333333333343338333333333333333';
const keys = await generateKeyPair('RS256'), forged = await generateKeyPair('RS256');
const second = Math.floor(Date.now() / 1000);
async function token(changes = {}, privateKey = keys.privateKey) {
  return new SignJWT({iss: DEVIN_ISSUER, aud: audience, sub: `org_id:${org}`, org_id: org, devin_id: session,
    iat: second, exp: second + 60, ...changes}).setProtectedHeader({alg: 'RS256'}).sign(privateKey);
}
function fixture(options = {}) {
  let connected = true, clock = second * 1000;
  const auth = createDevinWorkloads({audience, key: async () => keys.publicKey, now: () => clock,
    resolveOrganization: async value => connected && value === org ? 'org_local' : null, ...options});
  return {auth, revoke() {connected = false;}, expire() {clock += 60000;}};
}

test('Devin creates a session owner without impersonating the requester or granting another org', async () => {
  const {auth} = fixture();
  const identity = await auth.identify(await token({requesting_user_email: 'admin@operator.example', requesting_user_id: 'human-admin', service_user_id: 'service-admin'}));
  assert.equal(identity.status, 200);
  assert.equal(identity.principal.tenantId, 'org_local');
  assert.equal(identity.principal.userId, devinOwnerId(org, session));
  assert.equal(identity.principal.email, null);
  assert.deepEqual(identity.principal.owner, {kind: 'shared', provider: 'devin', organizationId: org, sessionId: session});
  assert.equal(await auth.revalidate(identity.principal, 'org_local'), identity.principal);
  await assert.rejects(auth.revalidate(identity.principal, 'org_other'), /denied/);
  await assert.rejects(auth.revalidate({...identity.principal}), /denied/);
  assert.notEqual(devinOwnerId(org, session), devinOwnerId(otherOrg, session));
  assert.notEqual(devinOwnerId(org, session), devinOwnerId(org, 'another-session'));
  assert.equal((await auth.identify(await token({org_id: otherOrg, sub: `org_id:${otherOrg}`}))).status, 403);
});

test('Devin rejects signature, issuer, audience, subject, expiry and session identity forgeries', async () => {
  const verify = createDevinVerifier({audience, key: async () => keys.publicKey, now: () => second * 1000});
  for (const changes of [
    {iss: 'https://untrusted.example'}, {aud: 'https://another.example'}, {aud: [audience, 'https://another.example']},
    {sub: 'unbound'}, {org_id: 'not-an-org'}, {devin_id: ''}, {devin_id: '../session'}, {devin_id: 'x'.repeat(201)},
    {exp: second - 1}, {exp: second}, {exp: second + 1, iat: second + 2}, {iat: second + 1}, {iat: undefined}, {exp: undefined},
  ]) assert.equal((await verify(await token(changes))).status, 401, JSON.stringify(changes));
  assert.equal((await verify(await token({}, forged.privateKey))).status, 401);
  assert.equal((await verify('not-a-token')).status, 401);
  assert.equal(isDevinToken('not-a-token'), false);
  assert.equal(isDevinToken(await token()), true);
  for (const value of ['https://operator.example/path', 'http://operator.example', 'file:///tmp/keys']) assert.throws(() => createDevinVerifier({audience: value}));
});

test('Devin accepts observed Cloud organization IDs and documented UUIDs but rejects malformed organization claims', async () => {
  const verify = createDevinVerifier({audience, key: async () => keys.publicKey, now: () => second * 1000});
  for (const value of [org, '11111111-1111-4111-8111-111111111111']) {
    const result = await verify(await token({org_id: value, sub: `org_id:${value}`}));
    assert.equal(result.status, 200);assert.equal(result.workload.organizationId, value);
  }
  for (const value of [org.toUpperCase(), org.slice(0, -1), org + '1', 'org_' + '1'.repeat(32), 'org-' + 'g'.repeat(32), '../' + org]) {
    assert.equal((await verify(await token({org_id: value, sub: `org_id:${value}`}))).status, 401, value);
  }
});

test('Devin revocation and expiration are rechecked before releasing protected results', async () => {
  const revoked = fixture(), a = await revoked.auth.identify(await token());
  assert.equal(a.status, 200);
  revoked.revoke();
  await assert.rejects(revoked.auth.revalidate(a.principal), /revoked/);
  assert.equal((await revoked.auth.identify(await token())).status, 403);
  const expired = fixture(), b = await expired.auth.identify(await token());
  expired.expire();
  await assert.rejects(expired.auth.revalidate(b.principal), /denied/);
});

test('a self-host tenant pin and dependency failures cannot grant fallback access', async () => {
  const pinned = fixture({tenantId: 'org_expected'});
  assert.equal((await pinned.auth.identify(await token())).status, 403);
  const admitted = fixture({tenantId: 'org_local'});
  assert.equal((await admitted.auth.identify(await token())).status, 200);
  const keyDown = fixture({key: async () => {throw new Error('unavailable');}});
  assert.equal((await keyDown.auth.identify(await token())).status, 503);
  const registryDown = fixture({resolveOrganization: async () => {throw new Error('unavailable');}});
  assert.equal((await registryDown.auth.identify(await token())).status, 503);
});
