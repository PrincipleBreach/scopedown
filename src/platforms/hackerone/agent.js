// HackerOne operations for agents. Every GraphQL document here is fixed; agents only
// supply validated values for its variables.

import * as hackerone from './program.js';
import { pageRequest } from '../../agent/page.js';
import { pageAttach, fillHackerOneForm } from './page.js';
import { runInPlatform, cached, forget, RunnerError } from '../../agent/runner.js';

export const ORIGIN = 'https://hackerone.com';
const H1 = ORIGIN;
const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];

async function gql(query, variables = {}) {
  const out = await runInPlatform(ORIGIN, pageRequest, [{ path: '/graphql', method: 'POST', json: { query, variables }, csrf: true, csrfFrom: '/hacktivity/overview' }]);
  if (out?.error) throw new RunnerError(out.error.code, out.error.message);
  if (out?.status === 429) throw new RunnerError('rate_limited', 'HackerOne is rate limiting this account. Wait a minute and try again.');
  // GraphQL answers errors with 200, so any other status is the platform failing, whatever the body.
  if (!(out?.status >= 200 && out.status < 300) || typeof out.body !== 'object') throw new RunnerError('platform', `HackerOne returned HTTP ${out?.status}.`);
  if (out.body.errors?.length && !out.body.data) throw new RunnerError('platform', `HackerOne: ${out.body.errors[0].message}`);
  return out.body.data;
}

// A list under me. HackerOne answers a signed-out session with me: null, and a cursor it cannot
// read with the list set to null, so those are told apart instead of both reading as signed out.
function meList(data, field, cursor) {
  if (!data?.me) throw new RunnerError('signed_out', 'Sign in to HackerOne in this browser.');
  const conn = data.me[field];
  if (conn) return conn;
  if (cursor) throw new RunnerError('bad_request', 'Unknown cursor. Pass next_cursor from the previous page.');
  throw new RunnerError('platform', 'HackerOne returned no list.');
}

const PRIVATE_STATES = new Set(['soft_launched', 'sandboxed']);

export async function account() {
  return cached('h1:me', 60_000, async () => {
    const data = await gql('{ me { username } }');
    return { signed_in: Boolean(data?.me), username: data?.me?.username || null };
  });
}

// The raw team plus the normalized program, cached for five minutes.
export async function program(handle) {
  return cached(`h1:program:${handle}`, 5 * 60_000, async () => {
    const raw = await runInPlatform(ORIGIN, hackerone.fetchInPage, hackerone.inPageArgs({ handle }));
    // Only a missing program is not_found; a refused or failed request is the platform's error.
    if (raw?.error) throw new RunnerError(raw.reason || 'platform', raw.error);
    return hackerone.normalize(raw, { fetchedAt: new Date().toISOString() });
  });
}

export async function listPrograms({ privateOnly, query, limit = 25, cursor }) {
  const page = (after, first) => gql(`query ScopeDownPrograms($first: Int!, $after: String, $search: String) {
    me { teams_that_i_can_submit_reports_to(first: $first, after: $after, search: $search) {
      total_count pageInfo { hasNextPage endCursor }
      edges { cursor node { handle name state offers_bounties submission_state } }
    } }
  }`, { first, after: after || null, search: query || null });
  const row = (t) => ({
    platform: 'hackerone',
    handle: t.handle,
    name: t.name,
    visibility: { public_mode: 'public', soft_launched: 'private', sandboxed: 'sandbox' }[t.state] || t.state,
    offers_bounties: t.offers_bounties,
    submissions: t.submission_state,
    url: `${H1}/${t.handle}`,
  });

  if (!privateOnly) {
    const conn = meList(await page(cursor, limit), 'teams_that_i_can_submit_reports_to', cursor);
    return { programs: conn.edges.map((e) => row(e.node)), total: conn.total_count, next_cursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null };
  }

  // HackerOne cannot filter by visibility, so read pages of 100 and keep the private ones. The next
  // cursor is the cursor of the last program looked at, so the next call starts right after it.
  const out = [];
  let after = cursor || null;
  let more = true;
  for (let read = 0; read < 5 && more && out.length < limit; read++) {
    const conn = meList(await page(after, 100), 'teams_that_i_can_submit_reports_to', after);
    let i = 0;
    for (; i < conn.edges.length && out.length < limit; i++) {
      after = conn.edges[i].cursor;
      if (PRIVATE_STATES.has(conn.edges[i].node.state)) out.push(row(conn.edges[i].node));
    }
    more = i < conn.edges.length || conn.pageInfo.hasNextPage;
  }
  return {
    programs: out,
    next_cursor: more ? after : null,
    note: 'HackerOne has no private filter: each call reads up to 500 programs, so pass next_cursor until it is null.',
  };
}

export async function weaknesses(handle, { query, limit = 20, cursor }) {
  const search = async (text, first, after) => {
    const data = await gql(`query ScopeDownWeaknesses($handle: String!, $first: Int!, $after: String, $search: String) {
      team(handle: $handle) { team_weaknesses(first: $first, after: $after, search: $search) {
        total_count pageInfo { hasNextPage endCursor } nodes { instruction weakness { id name external_id } }
      } }
    }`, { handle, first, after: after || null, search: text || null });
    const c = data?.team?.team_weaknesses;
    if (!c) throw new RunnerError('not_found', `No HackerOne program "${handle}" is visible to this account.`);
    return c;
  };
  let conn = await search(query, limit, cursor);
  // HackerOne matches one contiguous phrase, so "stored xss" finds nothing. Search the most
  // distinctive word instead and keep the entries that contain every word.
  const words = String(query || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!conn.total_count && words.length > 1 && !cursor) {
    const wide = await search([...words].sort((a, b) => b.length - a.length)[0], 100);
    const nodes = wide.nodes.filter((n) => words.every((w) => `${n.weakness.name} ${n.weakness.external_id}`.toLowerCase().includes(w)));
    conn = { total_count: nodes.length, nodes: nodes.slice(0, limit), pageInfo: { hasNextPage: false } };
  }
  return {
    total: conn.total_count,
    weaknesses: conn.nodes.map((n) => ({ id: n.weakness.id, name: n.weakness.name, cwe: n.weakness.external_id || null, program_note: n.instruction || undefined })),
    next_cursor: conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null,
  };
}

// Finds exactly one weakness for a draft, by id, CWE or name.
export async function resolveWeakness(handle, input) {
  const want = String(input).trim();
  const { weaknesses: found } = await weaknesses(handle, { query: want.replace(/^cwe-?/i, ''), limit: 20 });
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const exact = found.filter((w) => w.id === want || norm(w.name) === norm(want) || norm(w.cwe) === norm(want) || norm(w.cwe) === norm(`cwe ${want}`));
  if (exact.length === 1) return exact[0];
  if (found.length === 1) return found[0];
  const candidates = (exact.length ? exact : found).slice(0, 8).map((w) => `${w.name}${w.cwe ? ` (${w.cwe})` : ''}`);
  throw new RunnerError(found.length ? 'ambiguous_weakness' : 'unknown_weakness', found.length
    ? `"${want}" matches several weaknesses. Pick one: ${candidates.join('; ')}.`
    : `No weakness on this program matches "${want}". Use get_weaknesses to search.`);
}

export async function disclosed({ handle, query, limit = 10, cursor }) {
  // Only plain words reach the search syntax.
  const words = String(query || '').replace(/[^\p{L}\p{N}\s._-]/gu, ' ').trim();
  const parts = ['disclosed:true'];
  if (handle) parts.push(`team_handle:${handle.replace(/[^\w.-]/g, '')}`);
  if (words) parts.push(`(${words})`);
  if (cursor && !/^\d+$/.test(cursor)) throw new RunnerError('bad_request', 'Unknown cursor. Pass next_cursor from the previous page.');
  const from = Number(cursor || 0);
  const data = await gql(`query ScopeDownHacktivity($q: String!, $from: Int!, $size: Int!) {
    search(index: CompleteHacktivityReportIndex, query_string: $q, from: $from, size: $size, sort: { field: "latest_disclosable_activity_at", direction: DESC }) {
      total_count
      nodes { ... on HacktivityDocument { severity_rating cwe disclosed_at report { title url substate } team { handle name } } }
    }
  }`, { q: parts.join(' AND '), from, size: limit });
  const total = data.search.total_count;
  return {
    total,
    reports: data.search.nodes.filter((n) => n.report).map((n) => ({
      title: n.report.title,
      url: n.report.url,
      program: n.team?.handle,
      severity: n.severity_rating || null,
      weakness: n.cwe || null,
      state: n.report.substate,
      disclosed_at: n.disclosed_at,
    })),
    next_cursor: from + limit < Math.min(total, 10_000) ? String(from + limit) : null,
  };
}

export async function myReports({ handle, limit = 25, cursor }) {
  const data = await gql(`query ScopeDownMyReports($first: Int!, $after: String, $handle: String) {
    me { reports(first: $first, after: $after, handle: $handle, order_by: { direction: DESC, field: created_at }) {
      total_count pageInfo { hasNextPage endCursor }
      nodes { _id title substate created_at url severity { rating } team { handle name } }
    } }
  }`, { first: limit, after: cursor || null, handle: handle || null });
  const conn = meList(data, 'reports', cursor);
  return {
    total: conn.total_count,
    reports: conn.nodes.map((r) => ({
      platform: 'hackerone', id: r._id, title: r.title, state: r.substate, severity: r.severity?.rating || null,
      program: r.team?.handle, created_at: r.created_at, url: r.url,
    })),
    next_cursor: conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null,
  };
}

export async function myReport(id, { cursor } = {}) {
  const data = await gql(`query ScopeDownReport($id: Int!, $after: String) {
    report(id: $id) {
      _id title state substate created_at disclosed_at url vulnerability_information
      severity { rating score } weakness { name external_id } structured_scope { asset_identifier }
      team { handle name } reporter { username }
      activities(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename ... on ActivityInterface { created_at message internal actor { __typename ... on User { username } ... on Team { handle } } } }
      }
    }
  }`, { id: Number(id), after: cursor || null });
  const r = data?.report;
  if (!r) throw new RunnerError('not_found', `Report ${id} is not visible to this account.`);
  // Disclosed reports by other hunters are readable too, so say whose this is.
  const me = (await account()).username;
  // GraphQL shows another hunter's disclosed report without its body or summaries; the report's
  // JSON page has both. A limited disclosure has no body, and its summaries are the write-up.
  const page = r.disclosed_at && !cursor ? await disclosedPage(r._id) : null;
  return {
    platform: 'hackerone', id: r._id, title: r.title, state: r.substate, created_at: r.created_at, url: r.url,
    reporter: r.reporter?.username || null, yours: Boolean(me) && r.reporter?.username === me,
    program: r.team?.handle, severity: r.severity?.rating || null, weakness: r.weakness?.name || null,
    asset: r.structured_scope?.asset_identifier || null,
    description: cursor ? undefined : r.vulnerability_information || page?.vulnerability_information || null,
    disclosed_at: r.disclosed_at || null,
    summaries: page?.summaries,
    thread: (r.activities?.nodes || []).filter((a) => a.message).map((a) => ({
      at: a.created_at, type: a.__typename, by: a.actor?.username || a.actor?.handle || null, message: a.message,
    })),
    thread_cursor: r.activities?.pageInfo?.hasNextPage ? r.activities.pageInfo.endCursor : null,
  };
}

async function disclosedPage(id) {
  const out = await runInPlatform(ORIGIN, pageRequest, [{ path: `/reports/${id}.json`, accept: 'application/json' }]);
  if (out?.error || out?.status !== 200 || typeof out.body !== 'object') return null;
  const summaries = (out.body.summaries || []).filter((s) => s.content).map((s) => ({ by: s.category, content: s.content }));
  return { vulnerability_information: out.body.vulnerability_information || null, summaries: summaries.length ? summaries : undefined };
}

// HackerOne ids arrive as GraphQL global ids ("gid://hackerone/Weakness/60", base64);
// createReport takes the number at the end.
export function dbId(id) {
  if (id == null) return null;
  if (/^\d+$/.test(String(id))) return Number(id);
  try {
    const n = atob(String(id)).split('/').pop();
    return /^\d+$/.test(n) ? Number(n) : null;
  } catch {
    return null;
  }
}

// Files a draft the way HackerOne's report form does: each evidence file goes to /attachments,
// then one createReport call. `progress` records each finished step, so a worker restart resumes
// without uploading twice, and never files the report twice: an attempt is recorded before
// createReport, and a resumed run first looks for a report with this title filed since then.
export async function fileReport(draft, { files = [], progress = async () => {} } = {}) {
  const done = { ...(draft.filing || {}) };
  if (done.report_id) return { report_id: done.report_id, url: `${H1}/reports/${done.report_id}` };
  if (done.creating_at) {
    const mine = await myReports({ handle: draft.handle, limit: 10 });
    const hit = mine.reports.find((r) => r.title === draft.title && r.created_at >= new Date(Date.parse(done.creating_at) - 60_000).toISOString());
    if (hit) return { report_id: hit.id, url: `${H1}/reports/${hit.id}` };
  }

  // Uploads are remembered by attachment id, not file name: a file the agent replaced after a
  // failed attempt has a new id, so the retry uploads it instead of reusing the old one.
  done.uploaded ||= {};
  for (const f of files) {
    if (done.uploaded[f.id]) continue;
    const { id, ...file } = f;
    const up = await runInPlatform(ORIGIN, pageAttach, [{ ...file, csrfFrom: '/hacktivity/overview' }]);
    if (up?.error) throw new RunnerError(up.error.code, up.error.message);
    done.uploaded[id] = up.id;
    await progress(done);
  }
  const ids = files.map((f) => done.uploaded[f.id]).filter(Boolean);
  const byName = Object.fromEntries(files.map((f) => [f.name, done.uploaded[f.id]]));

  // {{attachment:name}} in the text becomes HackerOne's inline reference {F<id>}.
  const ref = (text) => String(text).replace(/\{\{attachment:([^}]+)\}\}/g, (all, name) => (byName[name.trim()] ? `{F${byName[name.trim()]}}` : all));
  const description = ref(reportBody(draft));

  done.creating_at = new Date().toISOString();
  await progress(done);
  const created = await gql(`mutation ScopeDownFile($input: CreateReportInput!) {
    createReport(input: $input) { was_successful errors { edges { node { message field } } } report { _id url } }
  }`, { input: {
    team_handle: draft.handle,
    title: draft.title,
    vulnerability_information: description,
    impact: ref(draft.impact),
    severity_rating: draft.severity,
    weakness_id: dbId(draft.weakness?.id),
    structured_scope_id: dbId(draft.asset?.id),
    source: 'web',
    attachment_ids: ids,
  } });
  failOn(created?.createReport, 'file the report');
  const reportId = created.createReport.report?._id;
  done.report_id = reportId;
  await progress(done);
  forget('h1:reports');
  return { report_id: reportId, url: reportId ? `${H1}/reports/${reportId}` : null };
}

// Fills HackerOne's own report form in the hunter's tab (page.js has the in-page half): asset,
// weakness, severity, title, description, impact, the program's custom fields and evidence.
// The hunter reviews and submits; HackerOne keeps the form as their draft until then.
export const prefill = {
  finish: 'Check it and press Submit report there.',
  func: fillHackerOneForm,
  args: (draft, files) => [{
    title: draft.title,
    asset: draft.asset?.identifier || null,
    weakness: draft.weakness?.name || null,
    severity: draft.severity || null,
    description: reportBody(draft),
    impact: draft.impact,
    custom: (draft.custom_fields || []).map((c) => ({ label: c.label, value: c.value })),
    files,
  }],
};

// The report form, for a hunter who wants to finish a draft on HackerOne.
export function formUrl(handle) {
  return `${H1}/${encodeURIComponent(handle)}/reports/new`;
}

// What a report to this program needs, and how it can be filed. Required custom fields
// only exist in HackerOne's own form (createReport has no input for them), so such programs
// are reviewed in ScopeDown and finished there.
export async function requirements(handle) {
  return cached(`h1:req:${handle}`, 5 * 60_000, async () => {
    const data = await gql(`query ScopeDownRequirements($handle: String!) {
      team(handle: $handle) {
        submission_state i_can_see_report_submit_button i_must_verify_identity_to_submit
        submission_requirements { asset_required weakness_required severity_required_at }
        custom_field_attributes(first: 50) { nodes { __typename
          ... on CustomFieldAttributeInterface { key label required field_type helper_text internal }
          ... on CustomFieldAttributesList { items }
          ... on CustomFieldAttributesText { regex error_message }
          ... on CustomFieldAttributesCheckbox { checkbox_text }
        } }
      }
    }`, { handle });
    const t = data?.team;
    if (!t) throw new RunnerError('not_found', `No HackerOne program "${handle}" is visible to this account.`);
    const prog = await program(handle);
    const custom = (t.custom_field_attributes?.nodes || []).filter((n) => n.key && !n.internal).map((n) => ({
      key: n.key,
      label: n.label.trim(),
      required: Boolean(n.required),
      type: String(n.field_type || 'text').toLowerCase(),
      options: n.items?.length ? n.items : undefined,
      pattern: n.regex || undefined,
      pattern_hint: (n.regex && n.error_message) || undefined,
      help: [n.helper_text, n.checkbox_text].filter(Boolean).join(' ') || undefined,
    }));
    const blocked = t.submission_state !== 'open' ? `Submissions to this program are ${t.submission_state}.`
      : t.i_must_verify_identity_to_submit ? 'HackerOne asks this account to verify its identity before submitting here.'
      : t.i_can_see_report_submit_button === false ? 'This account cannot submit to this program.'
      : null;
    const formOnly = custom.filter((c) => c.required).map((c) => c.label);
    const assets = prog.scopes.filter((s) => s.inScope).map((s) => ({ identifier: s.identifier, id: s.id, type: s.type, bounty: s.bounty, max_severity: s.maxSeverity || undefined }));
    return {
      can_submit: !blocked,
      blocked_reason: blocked || undefined,
      filing: formOnly.length ? 'platform_form' : 'direct',
      filing_note: formOnly.length
        ? `HackerOne only accepts these required fields in its own form: ${formOnly.join('; ')}. After the user approves the draft, ScopeDown fills HackerOne\'s form in their browser, custom fields included; they check it and submit.`
        : 'Filed by ScopeDown after the user approves it.',
      fields: {
        title: { required: true, max: 150 },
        asset: { required: Boolean(t.submission_requirements?.asset_required) || assets.length > 0 },
        weakness: { required: Boolean(t.submission_requirements?.weakness_required), source: 'get_weaknesses: a HackerOne weakness name, CWE id or id' },
        severity: { required: true, options: SEVERITIES },
        cvss_vector: { required: false },
        url: { required: false },
        http_request: { required: false },
        description: { required: true },
        impact: { required: true },
      },
      custom_fields: custom,
      assets,
    };
  });
}

// A report the hunter filed by hand from a handed-off draft: same program, same title.
export async function findFiled(draft, since) {
  const mine = await myReports({ handle: draft.handle, limit: 10 });
  const hit = mine.reports.find((r) => r.title === draft.title && (!since || r.created_at >= since));
  return hit ? { id: hit.id, url: hit.url } : null;
}

// The text HackerOne receives as the vulnerability information.
export function reportBody(draft) {
  const parts = [draft.description];
  if (draft.url) parts.push(`**Affected URL:** ${draft.url}`);
  if (draft.http_request) parts.push(`**Request**\n\n\`\`\`http\n${draft.http_request.replace(/```/g, '`\u200b``')}\n\`\`\``);
  if (draft.cvss_vector) parts.push(`CVSS: \`${draft.cvss_vector}\``);
  return parts.join('\n\n');
}

// Fields as HackerOne's report form names them, for the copy-and-finish handoff.
export function formFields(draft) {
  return [
    ['Title', draft.title],
    ['Asset', draft.asset?.identifier],
    ['Weakness', draft.weakness?.name],
    ['Severity', draft.severity],
    ['Proof of concept', reportBody(draft)],
    ['Impact', draft.impact],
    ...(draft.custom_fields || []).map((c) => [c.label, String(c.value)]),
  ].filter(([, v]) => v != null && v !== '');
}

function failOn(payload, action) {
  const messages = payload?.errors?.edges?.map((e) => [e.node.field, e.node.message].filter(Boolean).join(': ')).filter(Boolean) || [];
  if (payload?.was_successful && !messages.length) return;
  throw new RunnerError('platform', `HackerOne would not ${action}: ${messages.join('; ') || 'no reason given'}.`);
}
