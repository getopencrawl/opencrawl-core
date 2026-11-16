import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLegacyObjectClassifier} from '../dist/src/state/legacy-object-classification.mjs';
import {digest} from '../dist/src/sessions/event-identity.mjs';

const prefix = 'sessions/production/v1';
const owner = 'tenants/' + digest('org_new') + '/users/' + digest('user_new');
const raw = prefix + '/' + owner + '/codex/' + digest('installation') + '/' + digest('session') + '/' + digest('batch') + '.json.gz';

test('legacy classifier separates new-tenant raw captures from mutable state without becoming an authorization layer', () => {
  const {classify} = createLegacyObjectClassifier({prefix});
  assert.equal(classify(raw), null);
  assert.equal(classify(prefix + '/' + owner + '/onboarding/session.json').domain, 'onboarding');
  assert.equal(classify('raw/v1/source=slack/workspace=T1/connection=int_1/capture/messages-v1/run/pages/' + digest('page') + '.json'), null);
  assert.equal(classify('raw/v1/source=slack/workspace=T1/connection=int_1/capture/messages-v1/run/state.json').domain, 'slack-capture');
  assert.throws(() => classify(prefix + '/unrecognized-state.json'), /Unrecognized/);
  assert.throws(() => classify('connector-settings/v1/unrecognized.json'), /Unrecognized/);
});

test('legacy classifier preserves explicit offline raw-owner checks and isolated agent credential roots', () => {
  let observed;
  const bound = createLegacyObjectClassifier({prefix, validateRawTenantHash: hash => {observed = hash; throw new Error('foreign owner');}});
  assert.throws(() => bound.classify(raw), /foreign owner/);
  assert.equal(observed, digest('org_new'));
  const agents = createLegacyObjectClassifier({prefix, credentialPurpose: 'agent'});
  assert.deepEqual(agents.roots, [prefix + '/']);
  assert.equal(agents.classify(prefix + '/_credentials/' + digest('token') + '.json').domain, 'capture-credentials');
  assert.throws(() => agents.classify(raw), /unrelated application state/);
  assert.throws(() => agents.classify('connector-settings/v1/org_new/settings.enc'), /escaped/);
});

test('legacy classifier rejects malformed paths before raw passthrough', () => {
  const {classify} = createLegacyObjectClassifier({prefix});
  for (const key of ['', 'raw/../state', 'raw//key', 'raw/\0key', '/raw/key']) assert.throws(() => classify(key), /Invalid/);
  for (const value of ['', 'prefix/', 'prefix/../state', 'prefix\0']) assert.throws(() => createLegacyObjectClassifier({prefix: value}), /Invalid/);
});
