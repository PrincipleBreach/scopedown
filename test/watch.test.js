// The scope watch, run for real (engine, both platform adapters, runner, the operation) against
// fake HackerOne and Bugcrowd sites. What matters: new assets are found and dated by the
// platform, a second look finds nothing new, and a failed read never makes anything look removed.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'fake-indexeddb/auto';

const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const store = {};

// --- a fake HackerOne ----------------------------------------------------------------------
const h1 = { teams: {}, signedOut: false, failSignals: false, asked: [] };
const scope = (id, ident, created, extra = {}) => ({
  id: `gid://hackerone/StructuredScope/${id}`, asset_identifier: ident, asset_type: 'URL', human_asset_type: 'Domain',
  eligible_for_bounty: true, eligible_for_submission: true, max_severity: 'critical', instruction: null,
  created_at: created, updated_at: created, ...extra,
});
const b64 = (n) => Buffer.from(String(n)).toString('base64');
const signalNode = (handle) => {
  const list = [...h1.teams[handle].scopes].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { handle, newest: { total_count: list.length, nodes: list.slice(0, 1).map((s) => ({ created_at: s.created_at })) } };
};

function h1Answer({ query, variables }) {
  const op = /query (\w+)/.exec(query)[1];
  h1.asked.push(op);
  if (op === 'ScopeDownWatchList') {
    if (h1.signedOut) return { data: { me: null } };
    const all = Object.entries(h1.teams).map(([handle, t]) => ({ handle, name: t.name, state: t.state || 'public_mode', offers_bounties: true }));
    const from = variables.after ? Number(Buffer.from(variables.after, 'base64').toString()) : 0;
    return { data: { me: { teams_that_i_can_submit_reports_to: { pageInfo: { hasNextPage: from + 100 < all.length, endCursor: b64(from + 100) }, nodes: all.slice(from, from + 100) } } } };
  }
  if (op === 'ScopeDownWatchSignals') {
    if (h1.failSignals) return { status: 502 };
    // Like HackerOne's root teams query, private teams can be left out; the adapter asks for them by name.
    return { data: { teams: { nodes: variables.handles.filter((h) => h1.teams[h] && h1.teams[h].state !== 'soft_launched').map(signalNode) } } };
  }
  if (op === 'ScopeDownWatchSignal') {
    return { data: Object.fromEntries(['a', 'b', 'c'].map((k) => [k, h1.teams[variables[k]] ? signalNode(variables[k]) : null])) };
  }
  if (op === 'ScopeDownWatchScopes') {
    const page = (t) => [...t.scopes].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { data: { teams: { nodes: variables.handles.filter((h) => h1.teams[h] && h1.teams[h].state !== 'soft_launched').map((h) => {
      const list = page(h1.teams[h]);
      return { handle: h, structured_scopes: { total_count: list.length, pageInfo: { hasNextPage: list.length > 100, endCursor: b64(100) }, nodes: list.slice(0, 100) } };
    }) } } };
  }
  if (op === 'ScopeDownWatchScope') {
    const t = h1.teams[variables.handle];
    if (!t) return { data: { team: null } };
    const list = [...t.scopes].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const from = variables.after ? Number(Buffer.from(variables.after, 'base64').toString()) : 0;
    return { data: { team: { structured_scopes: { total_count: list.length, pageInfo: { hasNextPage: from + 100 < list.length, endCursor: b64(from + 100) }, nodes: list.slice(from, from + 100) } } } };
  }
  throw new Error(`unexpected HackerOne query ${op}`);
}

// --- a fake Bugcrowd -----------------------------------------------------------------------
const bc = { engagements: [], versions: {}, signedOut: false, asked: [] };
const doc = (code, groups) => ({ data: { brief: { name: code }, engagement: { code }, scope: groups } });
const group = (name, inScope, targets, reward = 5000) => ({ name, inScope, rewardRangeData: inScope && reward ? { 1: { min: 100, max: reward } } : {}, targets });
const target = (id, name, category = 'website') => ({ id, name, category, uri: '', tags: [] });

function bcAnswer(path) {
  const url = new URL(path, 'https://bugcrowd.com');
  bc.asked.push(url.pathname);
  if (url.pathname === '/submissions.json') return bc.signedOut ? { status: 401, body: {} } : { body: { submissions: [], meta: { totalHits: 0 } } };
  if (url.pathname === '/engagements.json') {
    const access = url.searchParams.get('access');
    const list = bc.signedOut && access === 'invite_only' ? [] : bc.engagements.filter((e) => (access === 'invite_only') === e.isPrivate);
    const page = Number(url.searchParams.get('page'));
    return { body: { engagements: list.slice((page - 1) * 24, page * 24), paginationMeta: { totalCount: list.length, limit: 24 } } };
  }
  let m = /^\/engagements\/([\w-]+)\/changelog\.json$/.exec(url.pathname);
  if (m) {
    const vs = bc.versions[m[1]] || [];
    return { body: { changelogs: [...vs].reverse().map((v, i) => ({ id: v.id, publishedAt: v.at, tags: v.tags, changelogState: i === 0 ? 'Latest' : null, changelogShowUrl: `/engagements/${m[1]}/changelog/${v.id}` })) } };
  }
  m = /^\/engagements\/([\w-]+)\/changelog\/([\w-]+)\.json$/.exec(url.pathname);
  if (m) return { body: bc.versions[m[1]].find((v) => v.id === m[2]).doc };
  throw new Error(`unexpected Bugcrowd request ${path}`);
}

globalThis.chrome = {
  runtime: { id: 'test', getManifest: () => ({ version: '9.9.9' }), getURL: (p) => `chrome-extension://test/${p}` },
  permissions: { contains: async () => true },
  storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } },
  tabs: {
    query: async ({ url }) => [{ id: url.includes('bugcrowd') ? 2 : 1, status: 'complete', url: url.replace('/*', '/robots.txt') }],
    create: async (o) => ({ id: 9, ...o }),
    get: async (id) => ({ id, status: 'complete' }),
    onUpdated: { addListener() {}, removeListener() {} },
    remove: async () => {},
  },
  scripting: {
    async executeScript({ target: { tabId }, func, args }) {
      assert.equal(func.name, 'pageRequest', 'the watch only makes plain page requests');
      const one = (req) => {
        const out = tabId === 1 ? h1Answer(req.json) : bcAnswer(req.path);
        return { status: out.status || 200, url: `https://x${req.path}`, body: out.body ?? out };
      };
      return [{ result: Array.isArray(args[0]) ? args[0].map(one) : one(args[0]) }];
    },
  },
};

const watch = await import('../src/agent/watch.js');
const { createOps } = await import('../src/agent/ops.js');
const { forget } = await import('../src/agent/runner.js');
const bcWatch = await import('../src/platforms/bugcrowd/watch.js');
const { category } = await import('../src/agent/assets.js');
bcWatch.pacing.ms = 0;
const dispatch = createOps({ build: async () => ({}) });
const call = async (op, params) => {
  const r = await dispatch(op, params, { name: 'test' });
  if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.result;
};
const all = (f = {}) => watch.listEvents(f);
const sweep = (platforms) => watch.sweep({ platforms, force: true });

before(async () => {
  // HackerOne: one program with an asset added three days ago, one with only old assets, and a
  // private program the root teams query leaves out.
  h1.teams.acme = { name: 'Acme', scopes: [scope(1, 'acme.com', ago(400 * DAY)), scope(2, 'api.acme.com', ago(3 * DAY)), scope(3, '*.acme.dev', ago(2 * DAY), { asset_type: 'WILDCARD', human_asset_type: 'Wildcard', max_severity: 'medium' })] };
  h1.teams.oldco = { name: 'Old Co', scopes: [scope(10, 'oldco.com', ago(900 * DAY)), scope(11, 'app.oldco.com', ago(800 * DAY), { eligible_for_bounty: false })] };
  h1.teams.secret = { name: 'Secret', state: 'soft_launched', scopes: [scope(20, 'internal.secret.io', ago(1 * DAY))] };
  // A program with more assets than one page holds.
  h1.teams.bigco = { name: 'Big Co', scopes: Array.from({ length: 150 }, (_, i) => scope(1000 + i, `h${i}.bigco.com`, ago((300 + i) * DAY))) };
  // Bugcrowd: a private engagement whose targets changed five days ago (t3 added), then a text-only
  // version two days ago.
  bc.engagements.push({ name: 'Widgets', briefUrl: '/engagements/widgets', isPrivate: true, rewardSummary: { maxReward: '$5,000' } });
  bc.versions.widgets = [
    { id: 'v1', at: ago(200 * DAY), tags: 'targets', doc: doc('widgets', [group('Core', true, [target('t1', 'widgets.com'), target('t2', 'api.widgets.com', 'api')]), group('Out', false, [])]) },
    { id: 'v2', at: ago(5 * DAY), tags: 'targets', doc: doc('widgets', [group('Core', true, [target('t1', 'widgets.com'), target('t2', 'api.widgets.com', 'api'), target('t3', 'Widgets Android', 'android')]), group('Out', false, [])]) },
    { id: 'v3', at: ago(2 * DAY), tags: 'brief', doc: doc('widgets', [group('Core', true, [target('t1', 'widgets.com'), target('t2', 'api.widgets.com', 'api'), target('t3', 'Widgets Android', 'android')]), group('Out', false, [])]) },
  ];
});

test('the first sweep dates recent additions from the platforms and records nothing else', async () => {
  await sweep();
  const events = await all();
  const added = events.map((e) => `${e.platform}:${e.asset}`).sort();
  assert.deepEqual(added, ['bugcrowd:Widgets Android', 'hackerone:*.acme.dev', 'hackerone:api.acme.com', 'hackerone:internal.secret.io']);
  for (const e of events) {
    assert.equal(e.kind, 'added');
    assert.equal(e.dated_by, 'platform');
  }
  assert.equal(events.find((e) => e.asset === 'api.acme.com').at, h1.teams.acme.scopes[1].created_at);
  assert.equal(events.find((e) => e.asset === 'Widgets Android').at, bc.versions.widgets[1].at, 'dated by the version that added it');
  assert.equal(events.find((e) => e.asset === 'Widgets Android').category, 'android');
  assert.equal(events.find((e) => e.asset === '*.acme.dev').category, 'wildcard');
  assert.ok(h1.asked.includes('ScopeDownWatchSignal'), 'the private program left out of the batch was asked for by name');
  assert.ok(h1.asked.includes('ScopeDownWatchScopes'), 'first pages are read in batches');
  assert.ok(h1.asked.includes('ScopeDownWatchScope'), 'a large program and the private one are read on their own');
  const status = await watch.sweepStatus();
  assert.equal(status.platforms.hackerone.programs, 4);
  assert.ok(status.platforms.hackerone.last_complete_at, 'a clean sweep is complete');
});

test('a sweep counts as running from the moment it starts', async () => {
  const run = watch.sweep({ platforms: ['hackerone'], force: true });
  assert.equal((await watch.sweepStatus()).state, 'running', 'a status read right after the call already sees it');
  await run;
  assert.equal((await watch.sweepStatus()).state, 'idle');
});

test('a second sweep with nothing changed records nothing new', async () => {
  const before = (await all()).length;
  await sweep();
  assert.equal((await all()).length, before);
});

test('later sweeps find added, removed and edited assets, new invitations and lost programs', async () => {
  const before = new Set((await all()).map((e) => e.id));
  const now = new Date().toISOString();
  h1.teams.acme.scopes.push(scope(4, 'pay.acme.com', now));
  h1.teams.acme.scopes = h1.teams.acme.scopes.filter((s) => s.asset_identifier !== 'acme.com');
  // An edit moves no signal: the rotation re-reads the program and finds it.
  Object.assign(h1.teams.oldco.scopes[1], { eligible_for_bounty: true, updated_at: now });
  h1.teams.fresh = { name: 'Fresh', state: 'soft_launched', scopes: [scope(30, 'fresh.example', ago(500 * DAY))] };
  delete h1.teams.secret;
  // On the second page of a large program: only a complete earlier read can show it went.
  h1.teams.bigco.scopes = h1.teams.bigco.scopes.filter((x) => x.asset_identifier !== 'h140.bigco.com');
  bc.versions.widgets.push({ id: 'v4', at: now, tags: 'targets', doc: doc('widgets', [group('Core', true, [target('t1', 'widgets.com'), target('t3', 'Widgets Android', 'android')]), group('Out', false, [target('t2', 'api.widgets.com', 'api')])]) });
  await sweep();

  const got = (await all()).filter((e) => !before.has(e.id)).map((e) => [e.platform, e.kind, e.asset ?? e.program, e.changes ?? e.reason ?? null]);
  const sorted = got.map((x) => JSON.stringify(x)).sort();
  assert.deepEqual(sorted, [
    ['bugcrowd', 'changed', 'api.widgets.com', { group: ['Core', 'Out'], in_scope: [true, false], bounty: [true, false] }],
    ['hackerone', 'added', 'fresh.example', 'new_program'],
    ['hackerone', 'added', 'pay.acme.com', null],
    ['hackerone', 'changed', 'app.oldco.com', { bounty: [false, true] }],
    ['hackerone', 'program_added', 'fresh', null],
    ['hackerone', 'program_removed', 'secret', null],
    ['hackerone', 'removed', 'acme.com', null],
    ['hackerone', 'removed', 'h140.bigco.com', null],
  ].map((x) => JSON.stringify(x)).sort());
  const pay = (await all()).find((e) => e.asset === 'pay.acme.com');
  assert.equal(pay.dated_by, 'platform');
  assert.equal(pay.at, now);
});

test('a failed signal or a signed-out session never makes anything look removed', async () => {
  const before = (await all()).length;
  h1.failSignals = true;
  await sweep(['hackerone']);
  h1.failSignals = false;
  assert.equal((await all()).length, before);
  assert.match(JSON.stringify((await watch.sweepStatus()).platforms.hackerone.errors), /HTTP 502/);

  h1.signedOut = true;
  await sweep(['hackerone']);
  h1.signedOut = false;
  assert.equal((await all()).length, before);

  // A signed-out Bugcrowd session still lists public engagements, but no private ones.
  bc.signedOut = true;
  forget('bc:me');
  await sweep(['bugcrowd']);
  bc.signedOut = false;
  forget('bc:me');
  assert.equal((await all()).length, before, 'the private engagement is not reported gone');
});

test('public Bugcrowd engagements are checked at most every two hours; private ones every sweep', () => {
  const now = Date.now();
  assert.equal(bcWatch.due({ program: { visibility: 'private' }, checked_at: ago(60_000) }, now), true);
  assert.equal(bcWatch.due({ program: { visibility: 'public' }, checked_at: ago(60_000) }, now), false);
  assert.equal(bcWatch.due({ program: { visibility: 'public' }, checked_at: ago(3 * 3_600_000) }, now), true);
});

test('Bugcrowd reads the versions that changed targets, and the one before them only without a snapshot', () => {
  const v = (id, days, tags) => ({ id, at: ago(days * DAY), tags: tags.split(',') });
  const versions = [v('v5', 1, 'brief'), v('v4', 3, 'targets'), v('v3', 10, 'others'), v('v2', 20, 'targets,brief'), v('v1', 90, 'targets')]; // newest first
  const since = ago(30 * DAY);
  assert.deepEqual(bcWatch.plan(versions, { sig: 'v5', since }).docs.map((x) => x.id), ['v2', 'v4', 'v5']);
  assert.equal(bcWatch.plan(versions, { sig: 'v5', since }).base.id, 'v1');
  assert.deepEqual(bcWatch.plan(versions, { sig: 'v5', version: 'v3', known: true, since }).docs.map((x) => x.id), ['v4', 'v5']);
  assert.equal(bcWatch.plan(versions, { sig: 'v5', version: 'v3', known: true, since }).base, null);
  assert.deepEqual(bcWatch.plan(versions, { sig: 'v5', fresh: true, since }).docs.map((x) => x.id), ['v5']);
  assert.equal(bcWatch.plan(versions, { sig: 'v5', since: ago(0.5 * DAY) }).base, null, 'nothing recent: just the current version');
});

test('list_scope_changes filters across every program', async () => {
  const ids = (r) => (r.changes || []).map((e) => e.asset ?? e.program).sort();
  const q = (p) => call('list_scope_changes', { refresh: false, since: '30d', ...p });
  assert.deepEqual(ids(await q({ kinds: ['added'], asset_types: ['wildcard'] })), ['*.acme.dev']);
  assert.deepEqual(ids(await q({ kinds: ['added'], asset_types: ['android', 'api'] })), ['Widgets Android']);
  assert.deepEqual(ids(await q({ kinds: ['added'], min_severity: 'high', platform: 'hackerone' })), ['api.acme.com', 'fresh.example', 'internal.secret.io', 'pay.acme.com']);
  assert.deepEqual(ids(await q({ kinds: ['program_added', 'program_removed'] })), ['fresh', 'secret']);
  assert.deepEqual(ids(await q({ visibility: 'private', kinds: ['added'] })), ['Widgets Android', 'fresh.example', 'internal.secret.io']);
  assert.deepEqual(ids(await q({ query: 'acme pay' })), ['pay.acme.com']);
  assert.deepEqual(ids(await q({ in_scope_only: true, kinds: ['changed'] })), ['api.widgets.com', 'app.oldco.com'], 'a move out of scope is a scope change');
  assert.deepEqual(ids(await q({ bounty_only: true, kinds: ['changed'] })), ['app.oldco.com']);
  assert.deepEqual(ids(await q({ platform: 'hackerone', handle: 'acme' })), ['*.acme.dev', 'acme.com', 'api.acme.com', 'pay.acme.com']);
  assert.deepEqual(ids(await q({ since: '1h', kinds: ['added'] })), ['fresh.example', 'pay.acme.com']);
  assert.deepEqual(ids(await q({ until: '4d', kinds: ['added'] })), ['Widgets Android']);

  const grouped = await q({ group_by: 'program', platform: 'hackerone' });
  assert.equal(grouped.programs.find((g) => g.program === 'acme').counts.added, 3);
  assert.equal(grouped.programs.find((g) => g.program === 'acme').counts.removed, 1);

  const page1 = await q({ limit: 2 });
  const page2 = await q({ limit: 2, cursor: page1.next_cursor });
  assert.equal(page1.changes.length, 2);
  assert.notDeepEqual(page1.changes[0].id, page2.changes[0].id);
  assert.ok(page1.total >= 9);
  for (let i = 1; i < page1.changes.length; i++) assert.ok(page1.changes[i - 1].at >= page1.changes[i].at, 'newest first');
});

test('list_scope_changes refuses filters it does not know', async () => {
  await assert.rejects(call('list_scope_changes', { refresh: false, kinds: ['new'] }), { code: 'bad_request' });
  await assert.rejects(call('list_scope_changes', { refresh: false, asset_types: ['domains'] }), { code: 'bad_request' });
  await assert.rejects(call('list_scope_changes', { refresh: false, since: 'last week' }), { code: 'bad_request' });
  await assert.rejects(call('list_scope_changes', { refresh: false, handle: 'acme' }), { code: 'bad_request' });
  await assert.rejects(call('list_scope_changes', { refresh: false, min_severity: 'p1' }), { code: 'bad_request' });
});

test('a platform the user switched off is neither checked nor listed', async () => {
  store.settings = { platforms: { bugcrowd: false } };
  const r = await call('list_scope_changes', { refresh: false, since: '30d' });
  assert.ok(r.changes.every((e) => e.platform !== 'bugcrowd'));
  await assert.rejects(call('list_scope_changes', { platform: 'bugcrowd', refresh: false }), { code: 'platform_disabled' });
  delete store.settings;
});

test('asset kinds are named the same on every platform', () => {
  assert.equal(category('URL', 'a.example.com'), 'web');
  assert.equal(category('WILDCARD', '*.example.com'), 'wildcard');
  assert.equal(category('Website', 'https://{subdomain}.example.com'), 'wildcard');
  assert.equal(category('CIDR', '10.0.0.0/8'), 'network');
  assert.equal(category('GOOGLE_PLAY_APP_ID', 'com.example'), 'android');
  assert.equal(category('APPLE_STORE_APP_ID', '123'), 'ios');
  assert.equal(category('Source code', 'github.com/example/*'), 'source_code');
  assert.equal(category('SMART_CONTRACT', '0xabc'), 'blockchain');
  assert.equal(category('something new', 'x'), 'other');
});

test('the MCP tool offers exactly the kinds, asset types and severities the extension accepts', () => {
  const server = readFileSync(new URL('../mcp/src/server.js', import.meta.url), 'utf8');
  const list = (name) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]+\\]);`).exec(server)[1].replace(/'/g, '"'));
  assert.deepEqual(list('KINDS'), watch.KINDS);
  assert.deepEqual(list('ASSET_TYPES'), watch.CATEGORIES);
  assert.deepEqual(list('SEVERITY'), watch.SEVERITIES);
});
