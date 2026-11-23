// The functions ScopeDown injects into a platform tab, run against a simulated signed-in
// HackerOne tab. The agent's worker tab shows robots.txt, so it has no csrf-token meta tag.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as hackerone from '../src/platforms/hackerone/program.js';
import { pageRequest } from '../src/agent/page.js';
import * as bugcrowd from '../src/platforms/bugcrowd/program.js';

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

test('a Bugcrowd engagement that does not exist is not_found, not a platform error', async () => {
  globalThis.location = { origin: 'https://bugcrowd.com', pathname: '/robots.txt' };
  globalThis.fetch = async () => new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } });
  const out = await bugcrowd.fetchInPage('no-such-engagement');
  assert.equal(out.reason, 'not_found', JSON.stringify(out));
  assert.match(out.error, /no-such-engagement/);
});

test('a Bugcrowd tab on a longer engagement name is not read as the one asked for', async () => {
  const requests = [];
  globalThis.location = { origin: 'https://bugcrowd.com', pathname: '/engagements/tesla-mbo' };
  globalThis.document = { querySelectorAll: () => [{ getAttribute: () => JSON.stringify({ engagementBriefApi: { getBriefVersionDocument: '/engagements/tesla-mbo/brief_versions/v1' } }) }] };
  globalThis.DOMParser = class { parseFromString() { return { querySelectorAll: () => [{ getAttribute: () => JSON.stringify({ engagementBriefApi: { getBriefVersionDocument: '/engagements/tesla/brief_versions/v9' } }) }] }; } };
  globalThis.fetch = async (path) => {
    requests.push(String(path));
    if (String(path).endsWith('.json')) return Response.json({ data: { brief: { name: String(path).includes('tesla-mbo') ? 'Tesla MBO' : 'Tesla' } } });
    return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  };
  const out = await bugcrowd.fetchInPage('tesla');
  assert.equal(out.error, undefined, out.error);
  assert.equal(out.brief.data.brief.name, 'Tesla', `requests: ${requests.join(', ')}`);
});
