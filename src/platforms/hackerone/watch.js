// HackerOne scope watch. HackerOne dates every asset (created_at, updated_at), so new assets are
// dated by the platform, even on the first sweep.
//
// The change signal per program is its asset count plus its newest asset's created_at, read for
// 40 programs per request (more than about 50 runs into HackerOne's 5 second query budget).
// An edit to an existing asset moves neither, so a few programs are re-read in full each sweep.

import { pageRequest } from '../../agent/page.js';
import { runInPlatform, RunnerError } from '../../agent/runner.js';
import { category, textHash } from '../../agent/assets.js';

const ORIGIN = 'https://hackerone.com';
const BATCH = 40;
const SCOPE_BATCH = 5;
const SCOPE_PAGES = 30; // 3,000 assets; past that a read is partial and records no removals

const LIST = `query ScopeDownWatchList($after: String) {
  me { teams_that_i_can_submit_reports_to(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { handle name state offers_bounties }
  } }
}`;

const SIGNALS = `query ScopeDownWatchSignals($handles: [String!], $first: Int!) {
  teams(first: $first, where: { handle: { _in: $handles } }) {
    nodes { handle newest: structured_scopes(first: 1, archived: false, order_by: { field: created_at, direction: DESC }) { total_count nodes { created_at } } }
  }
}`;

// HackerOne allows three aliases of one field per selection, so the fallback asks for three teams.
const SIGNALS_ONE = `query ScopeDownWatchSignal($a: String!, $b: String!, $c: String!) {
  a: team(handle: $a) { ...S } b: team(handle: $b) { ...S } c: team(handle: $c) { ...S }
}
fragment S on Team { handle newest: structured_scopes(first: 1, archived: false, order_by: { field: created_at, direction: DESC }) { total_count nodes { created_at } } }`;

const FIELDS = 'id asset_identifier asset_type human_asset_type eligible_for_bounty eligible_for_submission max_severity instruction created_at updated_at';

// Five programs' first page of assets in one request: about a second.
const SCOPES = `query ScopeDownWatchScopes($handles: [String!], $n: Int!) {
  teams(first: $n, where: { handle: { _in: $handles } }) {
    nodes { handle structured_scopes(first: 100, archived: false, order_by: { field: created_at, direction: DESC }) {
      total_count pageInfo { hasNextPage endCursor } nodes { ${FIELDS} }
    } }
  }
}`;

const SCOPE = `query ScopeDownWatchScope($handle: String!, $after: String) {
  team(handle: $handle) {
    structured_scopes(first: 100, after: $after, archived: false, order_by: { field: created_at, direction: DESC }) {
      total_count pageInfo { hasNextPage endCursor }
      nodes { ${FIELDS} }
    }
  }
}`;

const VISIBILITY = { public_mode: 'public', soft_launched: 'private', sandboxed: 'sandbox' };

// Runs several GraphQL requests in one visit to the tab, three at a time.
// Each answer is { data, errors } or { error }.
async function gqlMany(list) {
  const reqs = list.map(({ query, variables }) => ({ path: '/graphql', method: 'POST', json: { query, variables }, csrf: true, csrfFrom: '/hacktivity/overview' }));
  const out = await runInPlatform(ORIGIN, pageRequest, [reqs]);
  if (!Array.isArray(out)) throw new RunnerError(out?.error?.code || 'platform', out?.error?.message || 'HackerOne did not answer.');
  return out.map((r) => {
    if (r?.error) return { error: r.error.message };
    if (r.status === 429) return { error: 'HackerOne is rate limiting this account.', rateLimited: true };
    if (!(r.status >= 200 && r.status < 300) || typeof r.body !== 'object') return { error: `HackerOne returned HTTP ${r.status}.` };
    return { data: r.body.data || null, errors: r.body.errors || [] };
  });
}

export async function list() {
  const out = [];
  let after = null;
  for (let page = 0; page < 60; page++) {
    const [r] = await gqlMany([{ query: LIST, variables: { after } }]);
    if (r.error) throw new RunnerError(r.rateLimited ? 'rate_limited' : 'platform', r.error);
    if (!r.data?.me) throw new RunnerError('signed_out', 'Sign in to HackerOne in this browser.');
    const conn = r.data.me.teams_that_i_can_submit_reports_to;
    if (!conn) throw new RunnerError('platform', `HackerOne returned no program list${r.errors[0] ? `: ${r.errors[0].message}` : '.'}`);
    for (const t of conn.nodes) {
      out.push({ handle: t.handle, name: t.name, visibility: VISIBILITY[t.state] || t.state || null, bounties: t.offers_bounties ?? null, url: `${ORIGIN}/${t.handle}` });
    }
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new RunnerError('platform', 'HackerOne listed more programs than ScopeDown reads.');
}

const signalOf = (node) => {
  const conn = node?.newest;
  if (!conn) return null;
  const newest = conn.nodes?.[0]?.created_at || null;
  return { sig: `${conn.total_count}:${newest || ''}`, newest, count: conn.total_count };
};

// A node whose fields timed out comes back with an error naming its index: that one is unknown.
const failedNodes = (errors) => new Set((errors || []).map((e) => e.path?.[0] === 'teams' && e.path?.[1] === 'nodes' ? e.path[2] : null).filter((i) => i != null));

export async function signals(programs, progress = () => {}) {
  const out = new Map();
  const handles = programs.map((p) => p.handle);
  const batches = [];
  for (let i = 0; i < handles.length; i += BATCH) batches.push(handles.slice(i, i + BATCH));
  const missing = [];
  let done = 0;
  for (let i = 0; i < batches.length; i += 3) {
    const group = batches.slice(i, i + 3);
    const answers = await gqlMany(group.map((hs) => ({ query: SIGNALS, variables: { handles: hs, first: hs.length } })));
    answers.forEach((r, j) => {
      const asked = group[j];
      if (r.error || !r.data?.teams) {
        for (const h of asked) out.set(h, { error: r.error || 'HackerOne returned no signal.' });
        return;
      }
      const bad = failedNodes(r.errors);
      const got = new Map();
      r.data.teams.nodes.forEach((n, k) => { if (n?.handle && !bad.has(k)) got.set(n.handle.toLowerCase(), n); });
      for (const h of asked) {
        const s = signalOf(got.get(h.toLowerCase()));
        if (s) out.set(h, s);
        else missing.push(h);
      }
    });
    done += group.reduce((n, hs) => n + hs.length, 0);
    progress(done - missing.length);
    if (answers.some((r) => r.rateLimited)) break;
  }
  // Programs the batch query left out or timed out on are asked for by name, three at a time.
  for (let i = 0; i < missing.length; i += 9) {
    const chunk = missing.slice(i, i + 9);
    const trios = [];
    for (let j = 0; j < chunk.length; j += 3) trios.push(chunk.slice(j, j + 3));
    const answers = await gqlMany(trios.map((t) => ({ query: SIGNALS_ONE, variables: { a: t[0], b: t[1] ?? t[0], c: t[2] ?? t[0] } })));
    answers.forEach((r, j) => {
      trios[j].forEach((h, k) => {
        const s = signalOf(r.data?.[['a', 'b', 'c'][k]]);
        out.set(h, s || { error: r.error || r.errors?.[0]?.message || 'HackerOne did not show this program.' });
      });
    });
  }
  for (const h of handles) if (!out.has(h)) out.set(h, { error: 'Not checked: HackerOne is rate limiting this account.' });
  return out;
}

export function asset(n) {
  const type = n.human_asset_type || n.asset_type || '';
  return {
    id: n.id,
    asset: String(n.asset_identifier || '').trim(),
    type,
    category: category(n.asset_type || type, n.asset_identifier),
    in_scope: Boolean(n.eligible_for_submission),
    bounty: n.eligible_for_bounty == null ? null : Boolean(n.eligible_for_bounty),
    max_severity: n.max_severity || null,
    notes: textHash(n.instruction),
    created_at: n.created_at || null,
    updated_at: n.updated_at || null,
  };
}

export async function scopes(items, progress = () => {}) {
  const out = new Map();
  const state = items.map((it) => ({ handle: it.handle, nodes: [], after: null, pages: 0, total: null, done: false, error: null }));
  let read = 0;
  const take = (s, conn) => {
    s.nodes.push(...conn.nodes);
    s.total = conn.total_count;
    s.pages++;
    s.after = conn.pageInfo.endCursor;
    s.partial = conn.pageInfo.hasNextPage;
    s.done = !conn.pageInfo.hasNextPage || s.pages >= SCOPE_PAGES;
    if (s.done) progress(++read);
  };
  const limited = (answers) => {
    if (!answers.some((r) => r.rateLimited)) return false;
    for (const s of state.filter((x) => !x.done)) { s.error = 'Not read: HackerOne is rate limiting this account.'; s.done = true; }
    return true;
  };

  // First pages, five programs per request and three requests per visit to the tab.
  const groups = [];
  for (let i = 0; i < state.length; i += SCOPE_BATCH) groups.push(state.slice(i, i + SCOPE_BATCH));
  for (let i = 0; i < groups.length; i += 3) {
    const trio = groups.slice(i, i + 3);
    const answers = await gqlMany(trio.map((g) => ({ query: SCOPES, variables: { handles: g.map((s) => s.handle), n: g.length } })));
    answers.forEach((r, j) => {
      const bad = failedNodes(r.errors);
      const got = new Map();
      (r.data?.teams?.nodes || []).forEach((n, k) => { if (n?.handle && n.structured_scopes && !bad.has(k)) got.set(n.handle.toLowerCase(), n.structured_scopes); });
      // A program left out or timed out is read on its own below.
      for (const s of trio[j]) if (got.has(s.handle.toLowerCase())) take(s, got.get(s.handle.toLowerCase()));
    });
    if (limited(answers)) break;
  }

  // Large programs keep paging, and the ones the batch left out are read by name.
  for (;;) {
    const open = state.filter((s) => !s.done).slice(0, 3);
    if (!open.length) break;
    const answers = await gqlMany(open.map((s) => ({ query: SCOPE, variables: { handle: s.handle, after: s.after } })));
    answers.forEach((r, j) => {
      const s = open[j];
      const conn = r.data?.team?.structured_scopes;
      if (r.error || !conn) {
        s.error = r.error || (r.data && !r.data.team ? 'HackerOne no longer shows this program to this account.' : r.errors?.[0]?.message || 'HackerOne returned no scope.');
        s.done = true;
        progress(++read);
        return;
      }
      take(s, conn);
    });
    if (limited(answers)) break;
  }
  for (const s of state) {
    if (s.error) {
      out.set(s.handle, { error: s.error });
      continue;
    }
    const newest = s.nodes[0]?.created_at || null;
    out.set(s.handle, { sig: `${s.total}:${newest || ''}`, snapshots: [{ at: null, partial: Boolean(s.partial), assets: s.nodes.map(asset) }] });
  }
  return out;
}

// Edits to existing assets move no signal, so this many programs are re-read each sweep, the ones
// read longest ago first: every program within a day at a sweep every half hour.
export const rotate = 30;
