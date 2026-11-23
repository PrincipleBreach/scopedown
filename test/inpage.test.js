// The functions ScopeDown injects into a platform tab, run against a simulated signed-in
// HackerOne tab. The agent's worker tab shows robots.txt, so it has no csrf-token meta tag.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as hackerone from '../src/platforms/hackerone/program.js';
import { pageRequest } from '../src/agent/page.js';

const TOKEN = 'tok-current';
let shellLoads;

// HackerOne refuses a signed-in POST without the session's CSRF token, like the real site.
function signedInTab({ meta = null } = {}) {
  shellLoads = 0;
  delete globalThis.__scopedownCsrf;
  globalThis.location = { origin: 'https://hackerone.com' };
  globalThis.document = { querySelector: (sel) => (sel === 'meta[name="csrf-token"]' && meta ? { getAttribute: () => meta } : null) };
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') {
      shellLoads++;
      return new Response(`<html><head><meta name="csrf-token" content="${TOKEN}"></head></html>`, { headers: { 'content-type': 'text/html' } });
    }
    if (init.headers?.['X-CSRF-Token'] !== TOKEN) return new Response('{"errors":[{"message":"forbidden"}]}', { status: 403, headers: { 'content-type': 'application/json' } });
    return Response.json({ data: { me: { username: 'hunter' }, team: { handle: 'security', name: 'HackerOne', structured_scopes: { nodes: [], pageInfo: { hasNextPage: false } }, bounty_table: null } } });
  };
}

beforeEach(() => signedInTab());

test('program fetch in a tab without the csrf meta tag reads the token from the site shell', async () => {
  const [handle, queries] = hackerone.inPageArgs({ handle: 'security' });
  const out = await hackerone.fetchInPage(handle, queries);
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.team.handle, 'security');
  assert.equal(shellLoads, 1);

  await hackerone.fetchInPage(handle, queries);
  assert.equal(shellLoads, 1, 'the token is reused within the tab');
});

test('program fetch replaces a stale token once and retries', async () => {
  globalThis.__scopedownCsrf = 'tok-from-an-old-session';
  const [handle, queries] = hackerone.inPageArgs({ handle: 'security' });
  const out = await hackerone.fetchInPage(handle, queries);
  assert.equal(out.error, undefined, out.error);
  assert.equal(shellLoads, 1);
});

test('the meta tag wins when the page has one', async () => {
  signedInTab({ meta: TOKEN });
  const [handle, queries] = hackerone.inPageArgs({ handle: 'security' });
  const out = await hackerone.fetchInPage(handle, queries);
  assert.equal(out.error, undefined, out.error);
  assert.equal(shellLoads, 0);
});

test('pageRequest replaces a stale token once and retries', async () => {
  Object.defineProperty(globalThis, '__scopedownCsrf', { value: 'tok-from-an-old-session', configurable: true });
  const out = await pageRequest({ path: '/graphql', method: 'POST', json: { query: '{ me { username } }' }, csrf: true, csrfFrom: '/hacktivity/overview' });
  assert.equal(out.status, 200, JSON.stringify(out));
  assert.equal(out.body.data.me.username, 'hunter');
});
