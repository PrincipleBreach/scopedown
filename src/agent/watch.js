// Scope watch: finds assets added to, removed from or changed in every program the user can
// submit to, and programs that became available or went away. Nothing here names a platform.
//
// An adapter that supports it has agent.watch:
//   list()                       every program the account can submit to; throws if it cannot list them all
//   signals(programs, progress)  a cheap change signal per program: Map handle -> { sig, newest } or { error }
//   scopes(items, progress)      the program's assets now, as snapshots: Map handle ->
//                                { sig, snapshots: [{ at, assets, base, partial }] } or { error }
//   due(record, now)             optional: whether a program is checked in this sweep
//   rotate                       optional: programs re-read per sweep to catch edits the signal misses
//
// Each program's last snapshot lives in IndexedDB. A sweep lists programs, compares signals, reads
// the scope of programs whose signal moved, and records dated events. A removal is only recorded
// from a complete read: a failed request never makes an asset or a program look gone.

import { ADAPTERS } from '../platforms/index.js';
import { getSettings } from './store.js';
import { SEVERITIES } from './assets.js';

export { CATEGORIES, SEVERITIES } from './assets.js';

const DAY = 86_400_000;
export const BACKFILL_DAYS = 30; // the first sweep dates what the platforms added this far back
const KEEP_DAYS = 180;
const MAX_EVENTS = 20_000;
const FRESH_MS = 10 * 60_000; // a sweep this recent answers without starting another
const SLACK_MS = 5 * 60_000; // platform clocks and ours differ a little

export const KINDS = ['added', 'removed', 'changed', 'program_added', 'program_removed'];
// Fields whose change is news about the asset. A group's reward range is not: one change there
// would repeat on every target in the group, so it rides along on the asset's events instead.
const TRACKED = ['asset', 'type', 'location', 'group', 'in_scope', 'bounty', 'max_severity', 'notes'];

// --- storage -------------------------------------------------------------------------------

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('scopedown-watch', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('programs', { keyPath: 'key' });
      d.createObjectStore('events', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getAll(store) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function write(store, rows, remove = []) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    for (const r of rows) s.put(r);
    for (const k of remove) s.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('The browser aborted the scope watch write, for example because the disk is full.'));
  });
}

async function getMeta(key) {
  return (await getAll('meta')).find((m) => m.key === key) || { key };
}

// --- the sweep -----------------------------------------------------------------------------

let running = null;
const progress = {};
let lastSweep = null;

function watched(platform) {
  return ADAPTERS.filter((a) => a.agent.watch && (!platform || a.id === platform));
}

// Starts a sweep unless one is running or one finished recently. Resolves when it ends. It
// counts as running from this call on, so a status read right after it already says so.
export function sweep({ platforms = null, force = false } = {}) {
  if (running) return running;
  const started = new Date().toISOString();
  const run = (async () => {
    const settings = await getSettings();
    const list = watched().filter((a) => settings.platforms[a.id] !== false && (!platforms || platforms.includes(a.id)));
    const recent = await Promise.all(list.map(async (a) => (await getMeta(a.id)).finished_at));
    if (!list.length || (!force && recent.every((t) => t && Date.now() - Date.parse(t) < FRESH_MS))) return null;
    for (const a of list) progress[a.id] = { stage: 'listing', programs: 0, checked: 0, to_read: 0, read: 0, changes: 0, errors: [] };
    await Promise.all(list.map((a) => sweepPlatform(a, progress[a.id]).catch((e) => {
      progress[a.id].errors.push(e.message || String(e));
      progress[a.id].stage = 'failed';
    })));
    await prune();
    lastSweep = { started_at: started, finished_at: new Date().toISOString() };
    return lastSweep;
  })();
  running = run.finally(() => { running = null; });
  return running;
}

export function sweepRunning() {
  return Boolean(running);
}

// Waits up to ms for the running sweep.
export async function waitSweep(ms) {
  if (!running || ms <= 0) return;
  await Promise.race([running.catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

export async function sweepStatus() {
  const out = { state: running ? 'running' : 'idle', ...(lastSweep || {}), platforms: {} };
  for (const a of watched()) {
    const meta = await getMeta(a.id);
    const p = progress[a.id];
    out.platforms[a.id] = {
      ...(running && p ? { stage: p.stage } : {}),
      programs: p?.programs ?? meta.programs ?? 0,
      checked: p?.checked ?? 0,
      read: p?.read ?? 0,
      ...(p?.took_s != null ? { took_s: p.took_s } : {}),
      ...(running && p ? { to_read: p.to_read } : {}),
      watching_since: meta.baseline_at || null,
      last_complete_at: meta.complete_at || null,
      ...(p?.errors?.length ? { errors: [...new Set(p.errors)].slice(0, 5) } : {}),
    };
  }
  return out;
}

async function sweepPlatform(a, p) {
  const w = a.agent.watch;
  const now = Date.now();
  const seen = new Date(now).toISOString();
  const meta = await getMeta(a.id);
  const first = !meta.baseline_at;
  const backfill = new Date(now - BACKFILL_DAYS * DAY).toISOString();
  const stored = new Map((await getAll('programs')).filter((r) => r.platform === a.id).map((r) => [r.handle, r]));
  const events = [];

  // 1. Which programs the account can submit to. Only a complete list can show one went away.
  let listed = null;
  try {
    listed = await w.list();
  } catch (e) {
    p.errors.push(e.message);
    if (e.code === 'signed_out' || !stored.size) throw e;
  }
  const recs = [];
  const fresh = new Set();
  if (listed) {
    const names = new Set(listed.map((x) => x.handle));
    for (const r of stored.values()) {
      if (names.has(r.handle) || r.gone_at) continue;
      r.gone_at = seen;
      if (!first) events.push(programEvent('program_removed', r, seen));
      recs.push(r);
    }
    for (const x of listed) {
      let r = stored.get(x.handle);
      if (!r || r.gone_at) {
        if (!first) fresh.add(x.handle);
        r = r || { key: `${a.id}:${x.handle}`, platform: a.id, handle: x.handle, sig: null, assets: null, checked_at: null, fetched_at: null, first_seen: seen };
        r.gone_at = null;
      }
      r.program = { name: x.name || x.handle, visibility: x.visibility || null, bounties: x.bounties ?? null, url: x.url, legacy: x.legacy || undefined };
      recs.push(r);
      if (fresh.has(x.handle)) events.push(programEvent('program_added', r, seen));
    }
  } else {
    recs.push(...[...stored.values()].filter((r) => !r.gone_at));
  }
  const live = recs.filter((r) => !r.gone_at);
  p.programs = live.length;

  // 2. Cheap signals for the programs due this time.
  p.stage = 'checking';
  const due = live.filter((r) => fresh.has(r.handle) || !w.due || w.due(r, now));
  const signals = await w.signals(due.map((r) => ({ handle: r.handle, program: r.program, known: r.version || null })), (n) => { p.checked = n; });
  p.checked = due.length;

  // 3. Programs whose signal moved, new programs, the first sweep's recent changes, and a few
  // programs re-read in rotation (edits do not move every platform's signal).
  const read = [];
  for (const r of due) {
    const s = signals.get(r.handle);
    if (!s || s.error) {
      if (s?.error) p.errors.push(`${r.handle}: ${s.error}`);
      continue;
    }
    r.signal = s;
    const moved = r.sig != null && s.sig !== r.sig;
    const recent = r.sig == null && s.newest && s.newest >= (r.checked_at || backfill);
    if (fresh.has(r.handle) || moved || recent || (r.sig != null && s.sig == null)) read.push(r);
    else {
      r.sig = s.sig;
      r.checked_at = seen;
    }
  }
  const rotate = w.rotate || 0;
  if (rotate) {
    const picked = new Set(read);
    read.push(...due.filter((r) => r.signal && !picked.has(r))
      .sort((x, y) => String(x.fetched_at || '').localeCompare(String(y.fetched_at || '')))
      .slice(0, rotate));
  }

  // 4. Read their scope and compare.
  p.stage = 'reading';
  p.to_read = read.length;
  const results = read.length
    ? await w.scopes(read.map((r) => ({ handle: r.handle, program: r.program, signal: r.signal, version: r.version || null, known: Boolean(r.assets), fresh: fresh.has(r.handle), since: r.checked_at || backfill })), (n) => { p.read = n; })
    : new Map();
  p.read = read.length;
  for (const r of read) {
    const res = results.get(r.handle);
    if (!res || res.error) {
      if (res?.error) p.errors.push(`${r.handle}: ${res.error}`);
      continue;
    }
    events.push(...compare(r, res, { seen, isNew: fresh.has(r.handle), since: r.checked_at || backfill }));
    r.sig = res.sig ?? r.signal.sig;
    r.version = res.version ?? null;
    r.fetched_at = seen;
    r.checked_at = seen;
  }

  for (const r of recs) delete r.signal;
  await write('programs', recs);
  await write('events', events);
  p.changes = events.length;
  p.stage = 'done';
  const complete = Boolean(listed) && signals.size === due.length && [...signals.values()].every((s) => !s.error)
    && read.every((r) => results.get(r.handle) && !results.get(r.handle).error);
  const done = new Date().toISOString();
  p.took_s = Math.round((Date.parse(done) - now) / 1000);
  await write('meta', [{ ...meta, baseline_at: meta.baseline_at || seen, finished_at: done, programs: live.length, ...(complete ? { complete_at: done } : {}) }]);
}

// Turns a program's stored assets and what the platform shows now into events.
export function compare(r, res, { seen, isNew = false, since }) {
  const out = [];
  let prev = r.assets ? new Map(Object.entries(r.assets)) : null;
  const sinceMs = Date.parse(since) - SLACK_MS;
  const fetchedMs = r.fetched_at ? Date.parse(r.fetched_at) - SLACK_MS : null;
  let partial = false;
  for (const snap of res.snapshots) {
    const cur = new Map(snap.assets.map((x) => [x.id, x]));
    if (snap.base) {
      prev ??= cur;
      continue;
    }
    if (!prev && isNew) {
      for (const x of cur.values()) out.push(assetEvent('added', r, x, { at: seen, dated_by: 'scopedown', seen, reason: 'new_program' }));
    } else if (!prev) {
      // Never read before: only what the platform dates after the last check counts as new.
      for (const x of cur.values()) {
        const at = x.created_at || null;
        if (at && Date.parse(at) >= sinceMs) out.push(assetEvent('added', r, x, { at, dated_by: 'platform', seen }));
      }
    } else {
      for (const [id, x] of cur) {
        const was = prev.get(id);
        if (!was) {
          const dated = (x.created_at && (fetchedMs == null || Date.parse(x.created_at) >= fetchedMs) && x.created_at) || snap.at;
          out.push(assetEvent('added', r, x, { at: dated || seen, dated_by: dated ? 'platform' : 'scopedown', seen }));
          continue;
        }
        const changes = {};
        for (const k of TRACKED) {
          if ((was[k] ?? null) === (x[k] ?? null)) continue;
          changes[k] = k === 'notes' ? 'edited' : [was[k] ?? null, x[k] ?? null];
        }
        if (Object.keys(changes).length) {
          const dated = (x.updated_at && (fetchedMs == null || Date.parse(x.updated_at) >= fetchedMs) && x.updated_at) || snap.at;
          out.push(assetEvent('changed', r, x, { at: dated || seen, dated_by: dated ? 'platform' : 'scopedown', seen, changes }));
        }
      }
      if (!snap.partial) {
        for (const [id, x] of prev) {
          if (!cur.has(id)) out.push(assetEvent('removed', r, x, { at: snap.at || seen, dated_by: snap.at ? 'platform' : 'scopedown', seen }));
        }
      }
    }
    partial = Boolean(snap.partial);
    // A partial read keeps the assets it could not see, so they do not look removed next time.
    prev = partial && prev ? new Map([...prev, ...cur]) : cur;
  }
  if (prev) r.assets = Object.fromEntries([...prev].map(([id, x]) => [id, strip(x)]));
  return out;
}

function strip(x) {
  const { id, asset, type, category: c, location, group, reward, in_scope: inScope, bounty, max_severity: sev, notes, created_at: created, updated_at: updated } = x;
  return { id, asset, type, category: c, location, group, reward, in_scope: inScope, bounty, max_severity: sev, notes, created_at: created, updated_at: updated };
}

function assetEvent(kind, r, x, { at, dated_by: datedBy, seen, reason, changes }) {
  return {
    id: `${r.platform}:${r.handle}:${kind}:${x.id}:${at}`,
    kind,
    ...(reason ? { reason } : {}),
    platform: r.platform,
    program: r.handle,
    program_name: r.program?.name || r.handle,
    visibility: r.program?.visibility || null,
    program_url: r.program?.url || null,
    asset: x.asset,
    asset_type: x.type || null,
    category: x.category || 'other',
    location: x.location || undefined,
    group: x.group || undefined,
    reward: x.reward || undefined,
    in_scope: Boolean(x.in_scope),
    bounty: x.bounty ?? null,
    max_severity: x.max_severity || null,
    ...(changes ? { changes } : {}),
    at,
    dated_by: datedBy,
    seen_at: seen,
  };
}

function programEvent(kind, r, seen) {
  const assets = r.assets ? Object.values(r.assets) : [];
  return {
    id: `${r.platform}:${r.handle}:${kind}::${seen}`,
    kind,
    platform: r.platform,
    program: r.handle,
    program_name: r.program?.name || r.handle,
    visibility: r.program?.visibility || null,
    program_url: r.program?.url || null,
    offers_bounties: r.program?.bounties ?? null,
    ...(assets.length ? { assets: assets.length } : {}),
    at: seen,
    dated_by: 'scopedown',
    seen_at: seen,
  };
}

async function prune() {
  const all = await getAll('events');
  const cutoff = new Date(Date.now() - KEEP_DAYS * DAY).toISOString();
  const sorted = all.sort((x, y) => y.seen_at.localeCompare(x.seen_at));
  const drop = sorted.filter((e, i) => i >= MAX_EVENTS || e.seen_at < cutoff).map((e) => e.id);
  if (drop.length) await write('events', [], drop);
}

// --- reading the events --------------------------------------------------------------------

// Filters run here, over everything the watch has recorded, so every filter covers every program.
export async function listEvents(f = {}) {
  const words = String(f.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const minSev = f.min_severity ? SEVERITIES.indexOf(f.min_severity) : -1;
  const kinds = f.kinds?.length ? new Set(f.kinds) : null;
  const cats = f.categories?.length ? new Set(f.categories) : null;
  const programKind = (e) => e.kind.startsWith('program_');
  return (await getAll('events'))
    // A change recorded under an older list of tracked fields, with none of today's, is not news.
    .filter((e) => e.kind !== 'changed' || Object.keys(e.changes || {}).some((k) => TRACKED.includes(k)))
    .filter((e) => !f.platform || e.platform === f.platform)
    .filter((e) => !f.handle || e.program.toLowerCase() === f.handle.toLowerCase())
    .filter((e) => !f.since || e.at >= f.since)
    .filter((e) => !f.until || e.at < f.until)
    .filter((e) => !kinds || kinds.has(e.kind))
    .filter((e) => !f.visibility || e.visibility === f.visibility)
    // Asset filters leave program events alone only when they ask nothing of assets.
    .filter((e) => !cats || (!programKind(e) && cats.has(e.category)))
    .filter((e) => !f.in_scope_only || programKind(e) || e.in_scope || (e.kind === 'changed' && e.changes?.in_scope))
    .filter((e) => !f.bounty_only || (programKind(e) ? e.offers_bounties !== false : e.bounty === true))
    .filter((e) => minSev < 0 || programKind(e) || e.max_severity == null || SEVERITIES.indexOf(e.max_severity) >= minSev)
    .filter((e) => !words.length || words.every((w) => `${e.asset || ''} ${e.location || ''} ${e.program} ${e.program_name} ${e.group || ''}`.toLowerCase().includes(w)))
    .sort((x, y) => y.at.localeCompare(x.at) || y.seen_at.localeCompare(x.seen_at) || x.id.localeCompare(y.id));
}

// The same events grouped by program, busiest and newest first.
export function byProgram(events, perProgram = 20) {
  const map = new Map();
  for (const e of events) {
    const k = `${e.platform}:${e.program}`;
    let g = map.get(k);
    if (!g) {
      g = { platform: e.platform, program: e.program, program_name: e.program_name, visibility: e.visibility, program_url: e.program_url, newest_at: e.at, counts: {}, changes: [] };
      map.set(k, g);
    }
    g.counts[e.kind] = (g.counts[e.kind] || 0) + 1;
    if (g.changes.length < perProgram) g.changes.push(e);
  }
  return [...map.values()].sort((x, y) => y.newest_at.localeCompare(x.newest_at));
}

// Clears what the watch stored, so the next sweep starts a new baseline.
export async function resetWatch() {
  const ids = async (store) => (await getAll(store)).map((x) => x.key ?? x.id);
  await write('programs', [], await ids('programs'));
  await write('events', [], await ids('events'));
  await write('meta', [], await ids('meta'));
}
