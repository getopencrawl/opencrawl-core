import {test} from 'node:test';
import assert from 'node:assert/strict';
import {singleOrganizationIdentity} from '../dist/src/identity/single-organization.mjs';
import {singleOrganizationPrincipal} from '../dist/src/identity/principal.mjs';
const org = 'org_team';
const identity = {authenticated: true, sessionId: 'session_a', user: {id: 'user_a', email: 'stale@example.com'}, organizationId: org};
function fixture() {
  const state = {role: 'member', active: true, session: true, verified: true, queries: []};
  const workos = {userManagement: {
    getUser: async id => ({id, email: id + '@example.com', emailVerified: state.verified}),
    listSessions: async userId => ({data: [{id: identity.sessionId, userId, status: state.session ? 'active' : 'revoked', endedAt: null, expiresAt: new Date(Date.now() + 100_000).toISOString()}], listMetadata: {after: null}}),
    listOrganizationMemberships: async input => {state.queries.push(input); return {data: [
      {userId: input.userId, organizationId: org, status: state.active ? 'active' : 'inactive', role: {slug: state.role}},
      {userId: input.userId, organizationId: 'org_foreign', status: 'active', role: {slug: 'admin'}},
    ]};},
  }};
  return {state, workos, admit: singleOrganizationIdentity(workos, org), resolve: singleOrganizationPrincipal(workos, org)};
}
test('browser and agent admission pin the configured organization even when users belong to others', async () => {
  const f = fixture();
  const a = await f.admit(identity), b = await f.admit({...identity, user: {id: 'user_b'}});
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.principal.tenantId, org); assert.equal(b.principal.tenantId, org);
  assert.notEqual(a.cacheScope, b.cacheScope); assert.equal(a.user.email, 'user_a@example.com');
  assert.deepEqual(await f.resolve(identity.user), {tenantId: org, userId: 'user_a'});
  assert.equal(await f.resolve(identity.user, 'org_foreign'), null);
  assert.equal((await f.admit({...identity, organizationId: 'org_foreign'})).status, 403);
  assert.ok(f.state.queries.every(input => input.organizationId === org));
});
test('current role, membership and session changes invalidate browser authority and cached scope', async () => {
  const f = fixture(), member = await f.admit(identity);
  f.state.role = 'admin'; const admin = await f.admit(identity);
  assert.notEqual(member.cacheScope, admin.cacheScope);
  f.state.active = false; assert.equal((await f.admit(identity)).status, 403); assert.equal(await f.resolve(identity.user), null);
  f.state.active = true; f.state.session = false; assert.equal((await f.admit(identity)).status, 401);
  f.state.session = true; f.state.verified = false; assert.equal((await f.admit(identity)).status, 403);
});
test('provider outages and ambiguous same-organization memberships fail closed', async () => {
  const f = fixture();
  f.workos.userManagement.listOrganizationMemberships = async () => {throw new Error('private provider detail');};
  assert.deepEqual(await f.admit(identity), {status: 503});
  f.workos.userManagement.listOrganizationMemberships = async () => ({data: Array.from({length: 2}, () => ({userId: 'user_a', organizationId: org, status: 'active'}))});
  assert.equal((await f.admit(identity)).status, 403);
  assert.throws(() => singleOrganizationIdentity(f.workos, ''), /one organization/);
});
