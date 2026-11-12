import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from '../src/router.tsx';
import {ProductDocument} from '../src/application/documents.tsx';

const api = 'https://capture.example.com';
const render = (page: unknown) => renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(ProductDocument, {page})));

test('capture setup covers Claude cloud and Grok Bot from the page data, without exposing markup from it', () => {
  const html = render({kind: 'capture', api, credential: {token: '<secret>', id: 'abc', expiresAt: '2027-11-05T00:00:00.000Z'}, revoked: false, script: '#!/bin/sh\necho <setup>'});
  assert.match(html, /Capture Claude cloud sessions/);
  assert.match(html, /OPENCRAWL_SESSIONS_TOKEN=&lt;secret&gt;/);
  assert.doesNotMatch(html, /<secret>|<setup>/);
  for (const text of ['Capture Grok Bot sessions', `opencrawl collect install --yes --harness grok-bot --defer-auth --api ${api}`, `opencrawl login --no-browser --api ${api}`, 'newly created Bot', 'a stored receipt confirms upload']) assert.ok(html.includes(text), text);
  // Shell operators in the copied command are escaped as text.
  assert.ok(html.includes('@getopencrawl/cli@next &amp;&amp; opencrawl collect install'));
  // The Grok Bot steps come after the Claude setup and before revoking a credential.
  assert.ok(html.indexOf('Capture Grok Bot sessions') > html.indexOf('Setup script'));
  assert.ok(html.indexOf('Capture Grok Bot sessions') < html.indexOf('Credential ID to revoke'));
  // Platforms that create a machine per task get the install that runs on each one,
  // built from the same API origin, with every supported agent named.
  for (const text of ['Capture on a cloud coding platform', 'Replicas or Codespaces', `opencrawl collect install --yes --defer-auth --api ${api} --json`, '--harness opencode,cursor,muse', 'OpenCode, Cursor and Muse Code', 'brand-new machine']) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf('Capture on a cloud coding platform') > html.indexOf('Capture Grok Bot sessions'));
  assert.ok(html.indexOf('Capture on a cloud coding platform') < html.indexOf('Credential ID to revoke'));
});
