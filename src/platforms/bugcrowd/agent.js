// Bugcrowd operations for agents. Bugcrowd has no researcher API, so these read the JSON
// endpoints and page data its own web app uses. Publishing a submission needs a captcha,
// so drafts end in the hunter's own browser tab.

import * as bugcrowd from './program.js';
import { pageRequest } from '../../agent/page.js';
import { bugcrowdFormProps, fillBugcrowdForm } from './page.js';
import { runInPlatform, cached, RunnerError } from '../../agent/runner.js';

export const ORIGIN = 'https://bugcrowd.com';
const BC = ORIGIN;
const PRIORITY_SEVERITY = { 1: 'critical', 2: 'high', 3: 'medium', 4: 'low', 5: 'none' };

async function getJson(path) {
  const out = await runInPlatform(ORIGIN, pageRequest, [{ path, accept: 'application/json' }]);
  if (out?.error) throw new RunnerError(out.error.code, out.error.message);
  if (out.status === 401 || out.status === 403 || /\/user\/sign_in/.test(out.url || '')) throw new RunnerError('signed_out', 'Sign in to Bugcrowd in this browser.');
  if (typeof out.body !== 'object') throw new RunnerError('platform', `Bugcrowd returned HTTP ${out.status}.`);
  return out.body;
}

export async function account() {
  return cached('bc:me', 60_000, async () => {
    try {
      const s = await getJson('/submissions.json?offset=0&sort=submitted-desc');
      return { signed_in: true, username: s.submissions?.[0]?.username || null };
    } catch (e) {
      if (e.code === 'signed_out') return { signed_in: false, username: null };
      throw e;
    }
  });
}

export async function program(code) {
  return cached(`bc:program:${code}`, 5 * 60_000, async () => {
    const raw = await runInPlatform(ORIGIN, bugcrowd.fetchInPage, bugcrowd.inPageArgs({ code }));
    if (raw?.error) throw new RunnerError('not_found', raw.error);
    return bugcrowd.normalize(raw, { fetchedAt: new Date().toISOString() });
  });
}

export async function form(code) {
  return cached(`bc:form:${code}`, 2 * 60_000, async () => {
    const out = await runInPlatform(ORIGIN, bugcrowdFormProps, [code]);
    if (out?.error) throw new RunnerError(out.error.code, out.error.message);
    return out;
  });
}

export async function listPrograms({ privateOnly, query, limit = 25, cursor }) {
  const page = Number(cursor) || 1;
  const want = String(query || '').toLowerCase();
  const out = [];
  let total = 0;
  let next = null;
  // Accepted private invitations first; public engagements only when searching.
  const access = privateOnly || !want ? ['invite_only'] : ['invite_only', 'open'];
  for (const a of access) {
    const body = await getJson(`/engagements.json?category=bug_bounty&page=${page}&access=${a}`);
    total += body.paginationMeta?.totalCount || 0;
    if ((body.engagements || []).length && page * (body.paginationMeta?.limit || 24) < (body.paginationMeta?.totalCount || 0)) next = String(page + 1);
    for (const e of body.engagements || []) {
      const code = e.briefUrl?.split('/').pop();
      if (want && !`${e.name} ${code}`.toLowerCase().includes(want)) continue;
      out.push({
        platform: 'bugcrowd',
        handle: code,
        name: e.name,
        visibility: e.isPrivate ? 'private' : 'public',
        rewards: e.rewardSummary?.summary || null,
        url: `${BC}${e.briefUrl}`,
      });
    }
  }
  return { programs: out.slice(0, limit), total, next_cursor: next };
}

// VRT entries as flat, searchable rows. Bugcrowd names an entry by its full dotted path
// ("cross_site_scripting_xss.stored.non_admin_to_anyone"): leaf ids alone repeat across
// categories. priority is Bugcrowd's baseline P1 to P5; null means it varies by context.
export function flattenVrt(nodes, trail = [], names = []) {
  const rows = [];
  for (const n of nodes || []) {
    const ids = [...trail, n.id];
    const path = [...names, n.name];
    if (n.children?.length) rows.push(...flattenVrt(n.children, ids, path));
    else rows.push({ id: ids.join('.'), name: path.join(' > '), priority: n.priority ?? null });
  }
  return rows;
}

export async function weaknesses(code, { query, limit = 20, cursor }) {
  const f = await form(code);
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = flattenVrt(f.vrt).filter((r) => words.every((w) => `${r.id} ${r.name}`.toLowerCase().includes(w)));
  const from = Number(cursor) || 0;
  return {
    total: rows.length,
    weaknesses: rows.slice(from, from + limit).map(withPriority),
    next_cursor: from + limit < rows.length ? String(from + limit) : null,
    quota: quota(f),
  };
}

export async function resolveWeakness(code, input) {
  const f = await form(code);
  const all = flattenVrt(f.vrt);
  const want = String(input).trim().toLowerCase();
  const exact = all.filter((r) => r.id.toLowerCase() === want || r.name.toLowerCase() === want);
  if (exact.length === 1) return withPriority(exact[0]);
  const words = want.split(/\s+/);
  const found = all.filter((r) => words.every((w) => `${r.id} ${r.name}`.toLowerCase().includes(w)));
  if (found.length === 1) return withPriority(found[0]);
  throw new RunnerError(found.length ? 'ambiguous_weakness' : 'unknown_weakness', found.length
    ? `"${input}" matches several VRT entries. Pick one id: ${found.slice(0, 8).map((r) => `${r.id} (${r.name})`).join('; ')}.`
    : `No VRT entry matches "${input}". Use get_weaknesses to search.`);
}

export function quota(f) {
  const t = f.throttle;
  if (!t) return null;
  return {
    weekly_remaining: t.weeklyRemaining ?? null,
    weekly_cap: t.weeklyCap ?? null,
    at_cap: Boolean(t.atCap || t.atOpenLimit),
    reason: t.reason || null,
  };
}

export async function myReports({ handle, limit = 25, cursor }) {
  // Bugcrowd pages by offset, 25 at a time; a filter by program needs a scan, so it reads up to 4 pages.
  const start = Number(cursor) || 0;
  const rows = [];
  let offset = start;
  let total = 0;
  for (let page = 0; page < (handle ? 4 : 1) && rows.length < limit; page++) {
    const body = await getJson(`/submissions.json?offset=${offset}&sort=submitted-desc`);
    total = body.meta?.totalHits ?? 0;
    const batch = body.submissions || [];
    for (const s of batch) {
      if (handle && ![s.submission_url, s.engagement_name, s.program_name].some((v) => String(v || '').toLowerCase().includes(handle.toLowerCase()))) continue;
      rows.push({
        platform: 'bugcrowd',
        id: s.reference_number,
        title: s.caption || s.title,
        state: s.substate,
        program: s.engagement_name || s.program_name,
        created_at: s.submitted_at || s.created_at,
        url: s.submission_url ? `${BC}${s.submission_url}` : null,
      });
    }
    offset += batch.length;
    if (!batch.length || offset >= total) break;
  }
  return { total, reports: rows.slice(0, limit), next_cursor: offset < total ? String(offset) : null };
}

function withPriority(row) {
  return { ...row, priority_label: row.priority ? `P${row.priority}` : 'varies' };
}

// A submission the hunter filed by hand from a handed-off draft, matched by its exact title.
export async function findFiled(draft, since) {
  const body = await getJson('/submissions.json?offset=0&sort=submitted-desc');
  const hit = (body.submissions || []).find((s) => (s.caption || s.title) === draft.title && (!since || (s.submitted_at || s.created_at || '') >= since));
  return hit ? { id: hit.reference_number, url: hit.submission_url ? `${BC}${hit.submission_url}` : null } : null;
}

// What a submission to this engagement needs, read from the engagement's own form.
// Publishing needs a captcha, so Bugcrowd drafts always end in the hunter's browser.
export async function requirements(code) {
  const [f, prog] = await Promise.all([form(code), program(code)]);
  const inScope = prog.scopes.filter((s) => s.inScope);
  const assets = inScope.map((s) => ({
    identifier: s.identifier,
    id: f.targets.find((t) => t.name.trim().toLowerCase() === s.identifier.toLowerCase())?.id || null,
    type: s.type,
    group: s.group,
  }));
  const q = quota(f);
  const blocked = f.disabled ? 'Bugcrowd does not accept submissions from this account to this engagement right now.'
    : q?.at_cap ? 'This account reached its Bugcrowd submission limit for now.'
    : null;
  return {
    can_submit: !blocked,
    blocked_reason: blocked || undefined,
    filing: 'platform_form',
    filing_note: 'Bugcrowd protects publishing with a captcha. After the user approves the draft, ScopeDown fills Bugcrowd\'s form in their browser; they check it, solve the captcha and submit.',
    fields: {
      title: { required: true, max: 150 },
      asset: { required: f.targets.length > 0, note: 'Bugcrowd calls this the target.' },
      weakness: { required: true, source: 'get_weaknesses: a VRT id such as cross_site_scripting_xss.stored.non_admin_to_anyone. Its priority sets the baseline P1 to P5.' },
      severity: { required: true, options: ['none', 'low', 'medium', 'high', 'critical'], note: 'Advisory on Bugcrowd: the VRT entry decides the priority.' },
      url: { required: false, note: 'Bugcrowd "URL / location of vulnerability".' },
      http_request: { required: false, note: 'Bugcrowd "HTTP request".' },
      description: { required: true },
      impact: { required: true },
    },
    custom_fields: [],
    assets,
    quota: q,
  };
}

// The description Bugcrowd receives: the write-up, its impact, and evidence references as
// plain names (the files go in as attachments).
function body(draft) {
  const text = `${draft.description}\n\n## Impact\n\n${draft.impact}`;
  return text.replace(/\{\{attachment:([^}]+)\}\}/g, (_, name) => `\`${name.trim()}\` (attached)`);
}

// Fills Bugcrowd's own form in the hunter's tab (page.js has the in-page half). The hunter
// ticks the terms, solves the captcha and submits; Bugcrowd keeps it as a draft until then.
export const prefill = {
  finish: 'Check it, tick the terms, solve the captcha and submit there.',
  func: fillBugcrowdForm,
  args: (draft, files) => [{
    title: draft.title,
    target: draft.asset ? { id: draft.asset.id ?? null, name: draft.asset.identifier } : null,
    vrt: draft.weakness?.id || null,
    url: draft.url || null,
    description: body(draft),
    request: draft.http_request || null,
    files,
  }],
};

// Fields as Bugcrowd's submission form names them, for the copy-and-finish handoff.
export function formFields(draft) {
  const vrt = draft.weakness ? `${draft.weakness.name} (${draft.weakness.id}${draft.weakness.priority ? `, P${draft.weakness.priority}` : ''})` : null;
  return [
    ['Summary title', draft.title],
    ['Target', draft.asset?.identifier],
    ['Vulnerability type (VRT)', vrt],
    ['URL / location of vulnerability', draft.url],
    ['Description', body(draft)],
    ['HTTP request', draft.http_request],
  ].filter(([, v]) => v != null && v !== '');
}

// Bugcrowd's priority for a VRT entry, as the severity word ScopeDown shows.
export function severityFor(weakness) {
  return weakness?.priority ? PRIORITY_SEVERITY[weakness.priority] : null;
}

export function formUrl(code) {
  return `${BC}/engagements/${encodeURIComponent(code)}/submissions/new`;
}
