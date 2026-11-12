import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProviderCatalog} from '../dist/src/integrations/providers.mjs';
import {connectorManifest} from '../dist/src/integrations/manifests.mjs';

const circleback = createProviderCatalog({circleback: {name: 'circleback', manifest: connectorManifest('circleback')}}).circleback;
const API = 'https://circleback.ai/api';

/** Runs the account lookup against a folder list, as the credential proxy would return it. */
const account = folders => circleback.account(async ({endpoint}) => {
  if (endpoint === `${API}/oauth/test`) return {status: 200, data: {email: 'dana@example.test'}};
  if (endpoint === `${API}/folder`) return {status: 200, data: folders};
  throw new Error(`Unexpected request ${endpoint}`);
});
/** A folder as Circleback's folder list returns it: no `type`, and `visibility` says who can find it. */
const listed = (id, visibility, fields = {}) => ({id, name: id, url: `https://circleback.ai/folders/${id}`, access: 'Viewer', canAddMeetings: true,
  canReadMeetings: true, color: null, icon: null, isInvited: false, isMember: true, isRequestingToJoin: false, visibility, workspaceId: 41, ...fields});
const notInWorkspace = error => error.status === 400 && error.expose === true && /isn’t in a workspace/.test(error.message);

test('the Workspace folder is the listed folder whose visibility is null', async () => {
  const found = await account([
    listed('fHiring01', 'Hidden', {access: 'Editor'}),
    listed('fEveryone9', null, {name: 'Example Co'}),
    listed('fBoard02', 'Hidden', {access: null, canReadMeetings: false}),
  ]);
  assert.deepEqual(found, {label: 'dana@example.test, Example Co folder', workspace: '41', settings: {folderId: 'fEveryone9'}});
  // The string ID reaches the connector unchanged.
  assert.deepEqual(circleback.sourceConfiguration({startDate: '2026-01-01T00:00:00Z', record: {settings: found.settings}}),
    {start_date: '2026-01-01T00:00:00Z', folder_id: 'fEveryone9', num_workers: 2});
});

test('a shared folder listed to the workspace is not the Workspace folder', async () => {
  // "Workspace" visibility only makes a shared folder discoverable; its meetings belong to its members.
  await assert.rejects(account([listed('fCustomers', 'Workspace'), listed('fHiring01', 'Hidden')]), notInWorkspace);
  const found = await account([listed('fCustomers', 'Workspace'), listed('fEveryone9', null)]);
  assert.equal(found.settings.folderId, 'fEveryone9');
});

test('the earlier folder shape with a Workspace type is still accepted', async () => {
  const found = await account([{id: 'private', name: 'Private', type: 'Private', workspaceId: 7}, {id: 12, name: 'Example Co', type: 'Workspace', workspaceId: 7}]);
  assert.deepEqual(found, {label: 'dana@example.test, Example Co folder', workspace: '7', settings: {folderId: 12}});
  assert.equal(circleback.sourceConfiguration({startDate: '2026-01-01T00:00:00Z', record: {settings: found.settings}}).folder_id, '12');
  // A folder that says nothing about visibility is never taken for the Workspace folder.
  await assert.rejects(account([{id: 'private', name: 'Private', type: 'Private', workspaceId: 7}]), notInWorkspace);
});

test('an account without a Workspace folder is told why setup cannot continue', async () => {
  await assert.rejects(account([]), notInWorkspace);
  await assert.rejects(account([listed('fHiring01', 'Hidden'), listed('fBoard02', 'Hidden')]), notInWorkspace);
  // A Workspace folder that names no workspace cannot scope the imported data.
  await assert.rejects(account([listed('fEveryone9', null, {workspaceId: undefined})]), notInWorkspace);
});
