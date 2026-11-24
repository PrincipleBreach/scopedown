// Bugcrowd scope watch. Every engagement keeps a changelog of its published brief versions,
// newest first, each dated and tagged ("targets" when the scope changed). A version document
// holds the whole scope as it was, and a target keeps its id across versions, so each change is
// dated by the version that made it, even on the first sweep.
//
// Bugcrowd's firewall blocks fast clients for hours, so the watch makes one request a second and
// checks public engagements at most every two hours. Private ones are checked every sweep.

import { pageRequest } from '../../agent/page.js';
import { runInPlatform, RunnerError } from '../../agent/runner.js';
import { category, textHash } from '../../agent/assets.js';
import { normalize } from './program.js';
import { account, program } from './agent.js';

const ORIGIN = 'https://bugcrowd.com';
export const pacing = { ms: 1000 }; // tests lower it
const PUBLIC_EVERY_MS = 2 * 3600_000;
const MAX_DOCS = 6; // version documents read per engagement and sweep

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

// One paced JSON request. Refusals are per engagement here: only the listing decides signed_out.
async function get(path) {
  const wait = last + pacing.ms - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const out = await runInPlatform(ORIGIN, pageRequest, [{ path, accept: 'application/json' }]);
  if (out?.error) throw new RunnerError(out.error.code, out.error.message);
  if (/\/user\/sign_in/.test(out.url || '')) throw new RunnerError('signed_out', 'Sign in to Bugcrowd in this browser.');
  if (out.status === 401 || out.status === 403) throw new RunnerError('refused', 'Bugcrowd refused access. Accept the engagement\'s terms on bugcrowd.com.');
  if (out.status === 404) throw new RunnerError('not_found', 'Bugcrowd has no version history for this engagement.');
  if (out.status === 429) throw new RunnerError('rate_limited', 'Bugcrowd is rate limiting this account.');
  if (!(out.status >= 200 && out.status < 300) || typeof out.body !== 'object') throw new RunnerError('platform', `Bugcrowd returned HTTP ${out.status}.`);
  return out.body;
}

// A signed-out session still gets the public listing with HTTP 200, which would make every
// private engagement look gone. So the session is checked before and after listing.
async function signedIn() {
  const me = await account();
  if (!me.signed_in) throw new RunnerError('signed_out', 'Sign in to Bugcrowd in this browser.');
}

async function listing(access, kind) {
  const out = [];
  for (let page = 1; page <= 60; page++) {
    // Sorted by name, so the order does not shift while paging.
    const body = await get(`/engagements.json?${new URLSearchParams({ category: kind, page: String(page), access, sort_by: 'name', sort_direction: 'asc' })}`);
    const rows = body.engagements || [];
    out.push(...rows);
    if (!rows.length || out.length >= (body.paginationMeta?.totalCount ?? 0)) return out;
  }
  throw new RunnerError('platform', 'Bugcrowd listed more engagements than ScopeDown reads.');
}

// Private engagements of every kind, and public bug bounties (public VDPs pay nothing).
export async function list() {
  await signedIn();
  const mine = await listing('invite_only', '');
  const open = await listing('open', 'bug_bounty');
  await signedIn();
  const out = new Map();
  for (const e of [...mine, ...open]) {
    const handle = String(e.briefUrl || '').split('/').filter(Boolean).pop();
    if (!handle || e.isDemo || out.has(handle)) continue;
    const max = e.rewardSummary?.maxReward;
    out.set(handle, {
      handle,
      name: e.name,
      visibility: e.isPrivate ? 'private' : 'public',
      bounties: max ? /\d/.test(max) : null,
      url: `${ORIGIN}${e.briefUrl}`,
      legacy: !String(e.briefUrl).startsWith('/engagements/') || undefined,
    });
  }
  return [...out.values()];
}

export function due(r, now) {
  return r.program?.visibility !== 'public' || !r.checked_at || now - Date.parse(r.checked_at) >= PUBLIC_EVERY_MS;
}

function assetsOf(p) {
  return p.scopes.map((s) => ({
    id: s.id || `${s.type}|${s.identifier}`,
    asset: s.identifier,
    type: s.type,
    category: category(s.type, s.identifier),
    location: s.location || undefined,
    group: s.group,
    reward: p.groups[s.groupId]?.rewards || undefined,
    in_scope: s.inScope,
    bounty: s.bounty,
    max_severity: null,
    notes: textHash(s.notes),
  }));
}

const validDoc = (code, doc) => typeof doc === 'string' && /^[\w-]+$/.test(doc.slice(`/engagements/${code}/changelog/`.length)) && doc.startsWith(`/engagements/${code}/changelog/`);

// Without a changelog, the current brief is the signal: its assets, hashed.
async function fromBrief(code) {
  const assets = assetsOf(await program(code));
  return { sig: `brief:${textHash(JSON.stringify(assets))}`, newest: null, assets };
}

export async function signals(programs, progress = () => {}) {
  const out = new Map();
  let n = 0;
  let stop = null;
  for (const p of programs) {
    if (stop) {
      out.set(p.handle, { error: `Not checked: ${stop}` });
      continue;
    }
    try {
      if (p.program?.legacy) {
        out.set(p.handle, await fromBrief(p.handle));
      } else {
        const body = await get(`/engagements/${encodeURIComponent(p.handle)}/changelog.json`);
        const versions = (body.changelogs || []).filter((c) => validDoc(p.handle, c.changelogShowUrl)).map((c) => ({
          id: c.id, at: c.publishedAt || null, tags: String(c.tags || '').split(','), doc: c.changelogShowUrl, latest: c.changelogState === 'Latest',
        }));
        const latest = versions.find((v) => v.latest) || versions[0];
        out.set(p.handle, latest ? { sig: latest.id, newest: latest.at, versions } : await fromBrief(p.handle));
      }
    } catch (e) {
      if (e.code === 'not_found') {
        try {
          out.set(p.handle, await fromBrief(p.handle));
        } catch (e2) {
          out.set(p.handle, { error: e2.message });
        }
      } else {
        out.set(p.handle, { error: e.message });
        if (['signed_out', 'rate_limited', 'no_permission'].includes(e.code)) stop = e.message;
      }
    }
    progress(++n);
  }
  return out;
}

// Which version documents to read, oldest first. base is the version before them, read only
// when there is no stored snapshot to compare with.
export function plan(versions, { sig, version, known, fresh, since }) {
  const latest = versions.find((v) => v.id === sig) || versions[0];
  const oldestFirst = (list) => [...new Set(list)].sort((a, b) => versions.indexOf(b) - versions.indexOf(a));
  if (fresh) return { docs: [latest], base: null };
  if (known && version) {
    const at = versions.findIndex((v) => v.id === version);
    const newer = at >= 0 ? versions.slice(0, at) : [latest];
    return { docs: oldestFirst([...newer.filter((v) => v.tags.includes('targets')), latest]).slice(-MAX_DOCS), base: null };
  }
  const docs = oldestFirst([...versions.filter((v) => v.at && v.at >= since && v.tags.includes('targets')), latest]).slice(-MAX_DOCS);
  const before = versions[versions.indexOf(docs[0]) + 1];
  return { docs, base: docs[0].at && docs[0].at >= since ? before || null : null };
}

export async function scopes(items, progress = () => {}) {
  const out = new Map();
  let n = 0;
  for (const it of items) {
    const s = it.signal;
    try {
      if (s.assets) {
        out.set(it.handle, { sig: s.sig, snapshots: [{ at: null, assets: s.assets }] });
      } else {
        const { docs, base } = plan(s.versions, { sig: s.sig, version: it.version, known: it.known, fresh: it.fresh, since: it.since });
        const snapshots = [];
        for (const v of [base, ...docs].filter(Boolean)) {
          const body = await get(`${v.doc}.json`);
          if (!body?.data?.brief) throw new RunnerError('platform', 'Bugcrowd sent an unexpected brief version.');
          snapshots.push({ at: v.at, base: v === base || undefined, assets: assetsOf(normalize({ code: it.handle, brief: body }, { fetchedAt: v.at })) });
        }
        out.set(it.handle, { sig: s.sig, version: s.sig, snapshots });
      }
    } catch (e) {
      out.set(it.handle, { error: e.message });
    }
    progress(++n);
  }
  return out;
}
