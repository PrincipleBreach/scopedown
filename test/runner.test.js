// The runner picks which platform tab runs a page function, and opens and closes its own
// background worker tab when none of the user's tabs can.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const security = JSON.parse(readFileSync(new URL('./fixtures/hackerone-security.json', import.meta.url), 'utf8'));
const created = [];
const removed = [];
const updated = new Set();
const hooks = { tabs: () => [], page: async () => null };

globalThis.chrome = {
  permissions: { contains: async () => true },
  tabs: {
    query: async () => hooks.tabs(),
    create: async (o) => {
      const tab = { id: 100 + created.length, status: 'complete', ...o };
      created.push(tab);
      setTimeout(() => { for (const l of updated) l(tab.id, { status: 'complete' }); }, 0);
      return tab;
    },
    onUpdated: { addListener: (l) => updated.add(l), removeListener: (l) => updated.delete(l) },
    get: async (id) => ({ id, status: 'complete' }),
    remove: async (id) => { removed.push(id); },
  },
  scripting: { executeScript: async (o) => [{ result: await hooks.page(o) }] },
};

const { runInPlatform } = await import('../src/agent/runner.js');
const hackerone = await import('../src/platforms/hackerone/program.js');
const { pageRequest } = await import('../src/agent/page.js');

test('a HackerOne tab showing a 404 is skipped, and the next tab answers', async () => {
  const status = { 1: 404, 2: 200 };
  const tried = [];
  hooks.tabs = () => [
    { id: 1, status: 'complete', url: 'https://hackerone.com/some-dead-link', lastAccessed: 2000 },
    { id: 2, status: 'complete', url: 'https://hackerone.com/hacktivity/overview', lastAccessed: 1000 },
  ];
  hooks.page = async ({ target: { tabId }, func, args }) => {
    tried.push(tabId);
    globalThis.performance = { getEntriesByType: () => [{ responseStatus: status[tabId] }] };
    globalThis.document = { querySelector: () => ({ getAttribute: () => 'tok' }) };
    globalThis.location = { origin: 'https://hackerone.com', pathname: tabId === 1 ? '/some-dead-link' : '/hacktivity/overview' };
    globalThis.fetch = async () => Response.json({ data: { team: security.team } });
    return func(...args);
  };
  const out = await runInPlatform('https://hackerone.com', hackerone.fetchInPage, hackerone.inPageArgs({ handle: 'security' }));
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.equal(out.team.handle, security.team.handle);
  assert.deepEqual(tried, [1, 2]);
});

test('a worker tab that shows an error page is closed before another one opens', async () => {
  created.length = 0;
  removed.length = 0;
  hooks.tabs = () => created.filter((t) => !removed.includes(t.id));
  hooks.page = async () => ({ error: { code: 'bad_tab', message: 'This tab shows an error page (503).' } });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(runInPlatform('https://hackerone.com', pageRequest, [{ path: '/graphql' }]), { code: 'platform' });
  }
  const open = created.filter((t) => !removed.includes(t.id));
  assert.equal(open.length, 1, `still open: ${open.map((t) => t.id)}`);
});

test('a worker tab whose page replaces itself mid-run is waited for and tried again', async () => {
  hooks.tabs = () => [];
  let calls = 0;
  hooks.page = async () => {
    if (++calls === 1) throw new Error('Frame with ID 0 was removed.');
    return { status: 200 };
  };
  assert.deepEqual(await runInPlatform('https://hackerone.com', pageRequest, [{ path: '/graphql' }]), { status: 200 });
  assert.equal(calls, 2);

  hooks.page = async () => { throw new Error('Frame with ID 0 was removed.'); };
  await assert.rejects(runInPlatform('https://hackerone.com', pageRequest, [{ path: '/graphql' }]), { code: 'platform', message: /could not run in its https:\/\/hackerone.com tab/ });
});
