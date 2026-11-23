// The agent operations run here for real (ops, drafts, HackerOne layer, runner) against a
// fake browser that records every request a page would make. The point: an agent can never
// reach a platform mutation unless the hunter put that program on the auto-submit list.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';

const requests = []; // every page-side request: { kind, query, path }
const notes = [];
const store = {};
const listeners = new Set();

const security = JSON.parse(readFileSync(new URL('./fixtures/hackerone-security.json', import.meta.url), 'utf8'));
const tesla = JSON.parse(readFileSync(new URL('./fixtures/bugcrowd-tesla.json', import.meta.url), 'utf8'));
const VRT = [
  { id: 'cross_site_scripting_xss', name: 'Cross-Site Scripting (XSS)', children: [
    { id: 'stored', name: 'Stored', children: [
      { id: 'non_admin_to_anyone', name: 'Non-Privileged User to Anyone', priority: 2 },
      { id: 'self', name: 'Self', priority: 5 },
    ] },
    { id: 'reflected', name: 'Reflected', children: [{ id: 'non_self', name: 'Non-Self', priority: 3 }] },
  ] },
  { id: 'server_security_misconfiguration', name: 'Server Security Misconfiguration', children: [
    { id: 'clickjacking', name: 'Clickjacking', children: [{ id: 'non_sensitive_action', name: 'Non-Sensitive Action', priority: 5 }] },
    { id: 'self', name: 'Self', children: [{ id: 'varies', name: 'Varies' }] },
  ] },
];
security.team.id = Buffer.from('gid://hackerone/Engagements::BugBountyProgram/13').toString('base64');
security.team.structured_scopes.nodes.forEach((n, i) => { n.id = Buffer.from(`gid://hackerone/StructuredScope/${1000 + i}`).toString('base64'); });

const filedTitles = [];
// HackerOne connections page with per-item cursors (base64 offsets, like "MQ" for 1). A bad
// cursor nulls the field and adds an error; a signed-out session has me: null.
const h1Teams = [];
let h1SignedOut = false;
function h1Page(list, first, after) {
  const from = after == null ? 0 : Number(Buffer.from(after, 'base64').toString());
  if (after != null && !Number.isInteger(from)) return null;
  const slice = list.slice(from, from + first);
  return {
    total_count: list.length,
    pageInfo: { hasNextPage: from + first < list.length, endCursor: Buffer.from(String(from + slice.length)).toString('base64') },
    edges: slice.map((node, i) => ({ cursor: Buffer.from(String(from + i + 1)).toString('base64'), node })),
    nodes: slice,
  };
}

function answerGraphql(query, variables) {
  if (/ScopeDownPrograms/.test(query)) {
    if (h1SignedOut) return { me: null };
    const teams = h1Teams.filter((t) => !variables.search || t.name.toLowerCase().includes(variables.search.toLowerCase()));
    return { me: { teams_that_i_can_submit_reports_to: h1Page(teams, variables.first, variables.after) } };
  }
  if (/createReport\(input/.test(query)) {
    lastFiled = variables.input;
    if (refuseCreate) return { createReport: { was_successful: false, errors: { edges: [{ node: { field: 'severity_rating', message: 'is invalid' } }] }, report: null } };
    filedTitles.push({ title: variables.input.title, at: new Date().toISOString() });
    return { createReport: { was_successful: true, errors: { edges: [] }, report: { _id: '4242', url: 'https://hackerone.com/reports/4242' } } };
  }
  if (/ScopeDownMyReports/.test(query)) {
    if (variables.after === 'garbage') return { me: { reports: null } };
    return { me: { reports: { total_count: filedTitles.length, pageInfo: { hasNextPage: false }, nodes: filedTitles.map((f, i) => ({ _id: String(5150 + i), title: f.title, substate: 'new', created_at: f.at, url: `https://hackerone.com/reports/${5150 + i}`, team: { handle: 'security' } })) } } };
  }
  if (/team_weaknesses/.test(query)) return { team: { team_weaknesses: { total_count: 1, nodes: [{ instruction: null, weakness: { id: Buffer.from('gid://hackerone/Weakness/60').toString('base64'), name: 'Cross-site Scripting (XSS) - Stored', external_id: 'cwe-79' } }] } } };
  if (/me \{ username/.test(query)) return { me: { username: 'tester' } };
  if (/ScopeDownReport\(/.test(query)) {
    return { report: { _id: String(variables.id), title: 'A report', substate: 'triaged', created_at: '2026-11-01T00:00:00Z', url: `https://hackerone.com/reports/${variables.id}`, vulnerability_information: 'x', reporter: { username: variables.id === 1 ? 'tester' : 'someone-else' }, team: { handle: 'security' }, activities: { pageInfo: { hasNextPage: false }, nodes: [] } } };
  }
  if (/ScopeDownRequirements/.test(query)) {
    // "formonly" stands in for programs like PayPal or Uber: required custom fields.
    const custom = variables.handle !== 'formonly' ? [] : [
      { __typename: 'CustomFieldAttributesText', key: 'k_ip', label: 'Researcher IP Address', required: true, field_type: 'Text', helper_text: 'Testing IP', internal: false, regex: null },
      { __typename: 'CustomFieldAttributesList', key: 'k_fraud', label: 'Fraud Related?', required: true, field_type: 'List', items: ['Yes', 'No'], internal: false },
      { __typename: 'CustomFieldAttributesCheckbox', key: 'k_terms', label: 'Terms and Conditions', required: true, field_type: 'Checkbox', checkbox_text: 'I accept', internal: false },
    ];
    return { team: { submission_state: 'open', i_can_see_report_submit_button: true, i_must_verify_identity_to_submit: false, submission_requirements: { asset_required: false, weakness_required: variables.handle === 'formonly' }, custom_field_attributes: { nodes: custom } } };
  }
  return {};
}

// Bugcrowd's JSON lists, as the site serves them. Like Bugcrowd, submissions only honour filters
// in array form (offset[]=, sort[]=, draft[]=); a bare offset= is ignored. Engagements page by 24.
let refuseCreate = false; // HackerOne refuses createReport while set
let lastFiled = null;
let httpError = null; // set to an HTTP status to make every pageRequest fail with a JSON body
const bcSubmissions = [];
const bcEngagements = { invite_only: [], open: [] };
function bugcrowdJson(path) {
  const url = new URL(path, 'https://bugcrowd.com');
  if (url.pathname === '/submissions.json') {
    const offset = Number(url.searchParams.get('offset[]') || 0);
    const draft = url.searchParams.get('draft[]');
    const list = bcSubmissions.filter((x) => draft === null || String(Boolean(x.draft)) === draft);
    return { submissions: list.slice(offset, offset + 25), meta: { totalHits: list.length } };
  }
  const page = Number(url.searchParams.get('page') || 1);
  const search = (url.searchParams.get('search') || '').toLowerCase();
  const list = (bcEngagements[url.searchParams.get('access')] || []).filter((e) => !search || e.name.toLowerCase().includes(search));
  return { engagements: list.slice((page - 1) * 24, page * 24), paginationMeta: { totalCount: list.length, limit: 24 } };
}

globalThis.chrome = {
  runtime: { id: 'test', getManifest: () => ({ version: '0.3.0' }), getURL: (p) => `chrome-extension://test/${p}` },
  permissions: { contains: async () => true },
  tabs: {
    query: async () => [{ id: 7, status: 'complete', url: 'https://hackerone.com/security' }],
    create: async (o) => ({ id: 8, ...o }),
    get: async (id) => ({ id, status: 'complete', url: 'https://bugcrowd.com/engagements/tesla/submissions/new' }),
    onUpdated: { addListener() {}, removeListener() {} },
    remove: async () => {},
  },
  scripting: {
    async executeScript({ func, args }) {
      if (func.name === 'fetchInPage' && args.length === 1) {
        requests.push({ kind: 'bc-program', code: args[0] });
        return [{ result: structuredClone(tesla) }];
      }
      if (func.name === 'fetchInPage' && args[0] === 'refused') return [{ result: { error: 'HackerOne API returned HTTP 403.' } }];
      if (func.name === 'fetchInPage' && args[0] === 'ghost') return [{ result: { error: 'No program "ghost" is visible to this account.', reason: 'not_found' } }];
      if (func.name === 'fetchInPage') {
        requests.push({ kind: 'program', handle: args[0] });
        return [{ result: structuredClone({ team: security.team, warnings: [] }) }];
      }
      if (func.name === 'bugcrowdFormProps') {
        const targets = tesla.brief.data.scope.filter((g) => g.inScope).flatMap((g) => g.targets).map((t, i) => ({ id: `t-${i}`, name: t.name }));
        return [{ result: { username: 'tester', disabled: false, targets, vrt: VRT, throttle: { weeklyRemaining: 6, weeklyCap: 6, atCap: false }, captcha: true } }];
      }
      if (func.name === 'pageRequest' && httpError) {
        return [{ result: { status: httpError, url: `https://example.test${args[0].path}`, body: { error: 'Service trouble' } } }];
      }
      if (func.name === 'pageRequest') {
        const req = args[0];
        if (req.path.startsWith('/submissions.json') || req.path.startsWith('/engagements.json')) {
          return [{ result: { status: 200, url: `https://bugcrowd.com${req.path}`, body: bugcrowdJson(req.path) } }];
        }
        const query = req.json?.query || '';
        requests.push({ kind: 'request', path: req.path, query, variables: req.json?.variables });
        return [{ result: { status: 200, url: `https://hackerone.com${req.path}`, body: { data: answerGraphql(query, req.json?.variables) } } }];
      }
      if (func.name === 'fillHackerOneForm') {
        requests.push({ kind: 'fill-h1', data: structuredClone(args[0]) });
        return [{ result: { filled: ['Weakness', 'Severity', 'Title', 'Impact', 'Fraud Related?', 'Description'], missed: [] } }];
      }
      if (func.name === 'fillBugcrowdForm') {
        requests.push({ kind: 'fill', data: structuredClone(args[0]) });
        return [{ result: { filled: ['Summary title', 'Target', 'VRT', 'Description'], missed: ['URL: no URL field'] } }];
      }
      if (func.name === 'pageAttach') {
        const req = args[0];
        requests.push({ kind: 'attach', name: req.name, bytes: Buffer.from(req.base64, 'base64').length });
        return [{ result: { id: String(900 + requests.filter((r) => r.kind === 'attach').length), name: req.name } }];
      }
      throw new Error(`unexpected page function ${func.name}`);
    },
  },
  storage: {
    local: {
      async get(key) { return key in store ? { [key]: structuredClone(store[key]) } : {}; },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) { changes[k] = { newValue: structuredClone(v) }; store[k] = structuredClone(v); }
        for (const l of listeners) l(changes, 'local');
      },
    },
    onChanged: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  notifications: { create: async (id, o) => notes.push({ id, ...o }) },
};

let dispatch;
let drafts;
let setSettings;
before(async () => {
  ({ setSettings } = await import('../src/agent/store.js'));
  drafts = await import('../src/agent/drafts.js');
  const { createOps } = await import('../src/agent/ops.js');
  dispatch = createOps({ build: async () => ({ markdown: '# x', rules: [], targets: [], topReward: null }) });
  await setSettings({ agentEnabled: true });
});

const report = {
  platform: 'hackerone',
  handle: 'security',
  title: 'Stored XSS in report titles runs in triager browsers',
  asset: 'https://hackerone.com/reports/1',
  weakness: 'cwe-79',
  severity: 'high',
  description: 'Steps to reproduce: '.padEnd(120, 'x'),
  impact: 'Script runs in the triager session and can read reports.',
};
const mutations = () => requests.filter((r) => /^\s*mutation\b/.test(r.query));

test('a program the platform refuses is a platform error, not a missing program', async () => {
  const refused = (await dispatch('get_program', { platform: 'hackerone', handle: 'refused' })).error;
  assert.equal(refused.code, 'platform');
  assert.match(refused.message, /HTTP 403/);
  assert.equal((await dispatch('get_program', { platform: 'hackerone', handle: 'ghost' })).error.code, 'not_found');
});

test('unknown operations and malformed parameters are refused', async () => {
  assert.equal((await dispatch('run_graphql', { query: 'mutation { deleteEverything }' })).error.code, 'unknown_op');
  assert.equal((await dispatch('__proto__', {})).error.code, 'unknown_op');
  assert.equal((await dispatch('get_program', { platform: 'hackerone', handle: 'a b' })).error.code, 'bad_request');
  assert.equal((await dispatch('check_scope', { platform: 'hackerone', handle: 'security', targets: [] })).error.code, 'bad_request');
  assert.equal((await dispatch('get_my_report', { platform: 'hackerone', id: '1 OR 1' })).error.code, 'bad_request');
  assert.deepEqual(mutations(), []);
});

test('a draft is validated against live scope and never reaches HackerOne on its own', async () => {
  const out = await dispatch('draft_report', report, { name: 'claude-code' });
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.result.status, 'pending_review');
  assert.equal(out.result.asset, 'hackerone.com', 'the URL resolves to the in-scope asset that covers it');
  assert.equal(out.result.weakness, 'Cross-site Scripting (XSS) - Stored');
  assert.deepEqual(mutations(), [], 'no mutation was sent');
  assert.equal(notes.length, 1, 'the hunter is notified');

  const waited = await dispatch('get_draft', { draft_id: out.result.draft_id, wait_seconds: 1 });
  assert.equal(waited.result.status, 'pending_review', 'waiting does not change anything');
  assert.deepEqual(mutations(), []);
});

test('out-of-scope and unlisted assets are refused before a draft exists', async () => {
  const out = await dispatch('draft_report', { ...report, asset: 'support.hackerone.com' }, null);
  assert.equal(out.error.code, 'not_in_scope');
  assert.match(out.error.message, /out of scope/);
  const unlisted = await dispatch('draft_report', { ...report, asset: 'docs.hackerone.com' }, null);
  assert.equal(unlisted.error.code, 'not_in_scope');
  assert.deepEqual(mutations(), []);
});

test('the review page\'s Submit files it with one createReport call carrying every field', async () => {
  const list = await dispatch('list_drafts', { status: 'pending_review' });
  const id = list.result.drafts[0].draft_id;
  const done = await drafts.submitDraft(id, { by: 'user' });
  assert.equal(done.status, 'submitted');
  assert.equal(done.report.url, 'https://hackerone.com/reports/4242');
  assert.equal(mutations().length, 1);
  const input = mutations()[0].variables.input;
  assert.equal(input.team_handle, 'security');
  assert.equal(input.severity_rating, 'high');
  assert.equal(input.weakness_id, 60, 'weakness global id becomes the number createReport takes');
  assert.equal(typeof input.structured_scope_id, 'number');
  assert.equal(input.source, 'web');
});

test('auto-submit files immediately, but only for the listed program', async () => {
  requests.length = 0;
  await setSettings({ autoSubmit: ['hackerone:some_sandbox'] });
  const notListed = await dispatch('draft_report', { ...report, title: 'Second stored XSS in report titles path' }, null);
  assert.equal(notListed.result.status, 'pending_review');
  assert.deepEqual(mutations(), []);

  await setSettings({ autoSubmit: ['hackerone:security'] });
  const listed = await dispatch('draft_report', { ...report, title: 'Third stored XSS in report titles path' }, null);
  assert.equal(listed.result.status, 'submitted');
  assert.equal(mutations().length, 1);
  await setSettings({ autoSubmit: [] });
});

test('agents can revise a rejected draft, which goes back for review', async () => {
  const created = await dispatch('draft_report', { ...report, title: 'Fourth stored XSS in report titles path' }, null);
  const id = created.result.draft_id;
  await drafts.rejectDraft(id, 'Add the exact request.', { by: 'user' });
  const seen = await dispatch('get_draft', { draft_id: id });
  assert.equal(seen.result.status, 'rejected');
  assert.equal(seen.result.review_note, 'Add the exact request.');
  const revised = await dispatch('update_draft', { draft_id: id, description: 'Request: POST /graphql '.padEnd(150, 'y') }, { name: 'claude-code' });
  assert.equal(revised.result.status, 'pending_review');
  const submitted = await dispatch('list_drafts', { status: 'submitted' });
  const locked = await dispatch('update_draft', { draft_id: submitted.result.drafts[0].draft_id, title: 'Changing a filed report title' }, null);
  assert.equal(locked.error.code, 'locked');
});

test('the activity log records operations without report text', async () => {
  const log = store.activity;
  assert.ok(log.length >= 5);
  assert.ok(log.some((e) => e.op === 'draft_report' && e.client === 'claude-code'));
  assert.ok(!JSON.stringify(log).includes('Steps to reproduce'), 'report bodies stay out of the log');
});

async function attach(draftId, name, bytes, client = { name: 'claude-code' }) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const begin = await dispatch('attach_begin', { draft_id: draftId, name, size: bytes.length, sha256: sha }, client);
  assert.equal(begin.ok, true, JSON.stringify(begin.error));
  const { upload_id: id, chunk_bytes: size } = begin.result;
  for (let i = 0, at = 0; at < bytes.length; i++, at += size) {
    const c = await dispatch('attach_chunk', { upload_id: id, index: i, data: bytes.subarray(at, at + size).toString('base64') }, client);
    assert.equal(c.ok, true, JSON.stringify(c.error));
  }
  return dispatch('attach_end', { upload_id: id }, client);
}

test('evidence is verified, stored, uploaded at submit, and referenced inline', async () => {
  requests.length = 0;
  const created = await dispatch('draft_report', { ...report, title: 'Stored XSS with screenshot evidence', description: 'See {{attachment:poc.png}} for the alert box. '.padEnd(120, 'z') }, null);
  const id = created.result.draft_id;
  const png = Buffer.alloc(700_000, 7);
  const done = await attach(id, 'poc.png', png);
  assert.equal(done.ok, true, JSON.stringify(done.error));
  assert.deepEqual(done.result.attachments.map((a) => [a.name, a.size, a.type]), [['poc.png', 700_000, 'image/png']]);

  const damaged = await dispatch('attach_begin', { draft_id: id, name: 'x.png', size: 3, sha256: '0'.repeat(64) }, null);
  await dispatch('attach_chunk', { upload_id: damaged.result.upload_id, index: 0, data: Buffer.from('abc').toString('base64') }, null);
  const refused = await dispatch('attach_end', { upload_id: damaged.result.upload_id }, null);
  assert.equal(refused.error.code, 'bad_file', 'a SHA-256 mismatch is refused');
  assert.equal((await dispatch('attach_begin', { draft_id: id, name: 'id_rsa', size: 3, sha256: '0'.repeat(64) }, null)).error.code, 'bad_file');
  assert.equal((await attach(id, 'poc.png', Buffer.from('again'))).error.code, 'duplicate_file');

  const filed = await drafts.submitDraft(id, { by: 'user' });
  assert.equal(filed.status, 'submitted');
  const upload = requests.find((r) => r.kind === 'attach');
  assert.deepEqual([upload.name, upload.bytes], ['poc.png', 700_000]);
  const create = mutations()[0];
  assert.ok(requests.indexOf(upload) < requests.indexOf(create), 'files go up before the report is filed');
  assert.deepEqual(create.variables.input.attachment_ids, ['901']);
  assert.match(create.variables.input.vulnerability_information, /See \{F901\} for the alert box/, 'inline reference becomes {F<id>}');
});

test('auto-submit waits for announced files, then files everything together', async () => {
  requests.length = 0;
  await setSettings({ autoSubmit: ['hackerone:security'] });
  const created = await dispatch('draft_report', { ...report, title: 'Auto-submitted with one evidence file', attachments_pending: 1 }, null);
  assert.equal(created.result.status, 'pending_review', 'not filed before its file arrives');
  assert.deepEqual(mutations(), []);
  const done = await attach(created.result.draft_id, 'request.txt', Buffer.from('POST /graphql HTTP/1.1'));
  assert.equal(done.result.status, 'submitted');
  assert.deepEqual(requests.filter((r) => r.kind === 'attach').map((r) => [r.name, r.bytes]), [['request.txt', 22]]);
  await setSettings({ autoSubmit: [] });
});

test('a filing interrupted after createReport is adopted on resume, never filed twice', async () => {
  requests.length = 0;
  const created = await dispatch('draft_report', { ...report, title: 'Interrupted while filing the report' }, null);
  const id = created.result.draft_id;
  const { putDraft, getDraft } = await import('../src/agent/store.js');
  // The run died right after HackerOne accepted the report, before the result was saved.
  const at = new Date().toISOString();
  filedTitles.push({ title: 'Interrupted while filing the report', at });
  await putDraft({ ...(await getDraft(id)), status: 'submitting', filing: { creating_at: at, uploaded: {} } });
  await drafts.resumeInterrupted();
  for (let i = 0; i < 50 && (await getDraft(id)).status === 'submitting'; i++) await new Promise((r) => setTimeout(r, 20));
  const after = await getDraft(id);
  assert.equal(after.status, 'submitted');
  assert.match(after.report.url, /reports\/51\d\d$/, 'adopted the report the interrupted run filed');
  assert.deepEqual(mutations(), [], 'createReport was not called again');
});

test('an interruption before createReport resumes and files once', async () => {
  requests.length = 0;
  const created = await dispatch('draft_report', { ...report, title: 'Interrupted before filing anything' }, null);
  const id = created.result.draft_id;
  const { putDraft, getDraft } = await import('../src/agent/store.js');
  await putDraft({ ...(await getDraft(id)), status: 'submitting' });
  await drafts.resumeInterrupted();
  for (let i = 0; i < 80 && (await getDraft(id)).status === 'submitting'; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal((await getDraft(id)).status, 'submitted');
  assert.equal(mutations().length, 1);
});

test('get_report_requirements reports the filing route and the program\'s custom fields', async () => {
  const plain = await dispatch('get_report_requirements', { platform: 'hackerone', handle: 'security' });
  assert.equal(plain.result.filing, 'direct');
  assert.deepEqual(plain.result.custom_fields, []);
  assert.ok(plain.result.assets.some((a) => a.identifier === 'hackerone.com' && typeof a.id === 'string'));
  const form = await dispatch('get_report_requirements', { platform: 'hackerone', handle: 'formonly' });
  assert.equal(form.result.filing, 'platform_form');
  assert.deepEqual(form.result.custom_fields.map((c) => [c.label, c.type, c.required]), [['Researcher IP Address', 'text', true], ['Fraud Related?', 'list', true], ['Terms and Conditions', 'checkbox', true]]);
  assert.deepEqual(form.result.custom_fields[1].options, ['Yes', 'No']);
  assert.equal(form.result.fields.weakness.required, true);
});

test('required custom fields are enforced, and such drafts are finished in the platform form', async () => {
  requests.length = 0;
  const base = { ...report, handle: 'formonly', title: 'Report to a program with custom fields' };
  const missing = await dispatch('draft_report', base, null);
  assert.equal(missing.error.code, 'missing_fields');
  assert.match(missing.error.message, /Researcher IP Address/);
  assert.match(missing.error.message, /one of: Yes, No/);
  const badOption = await dispatch('draft_report', { ...base, custom_fields: { k_ip: '203.0.113.7', 'Fraud Related?': 'Maybe', 'Terms and Conditions': true } }, null);
  assert.equal(badOption.error.code, 'bad_field');
  const ok = await dispatch('draft_report', { ...base, custom_fields: { k_ip: '203.0.113.7', 'fraud related?': 'no', 'Terms and Conditions': 'yes' } }, null);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.result.filing, 'platform_form');
  assert.deepEqual(ok.result.custom_fields, { 'Researcher IP Address': '203.0.113.7', 'Fraud Related?': 'No', 'Terms and Conditions': true });
  const refused = await drafts.submitDraft(ok.result.draft_id, { by: 'user' }).catch((e) => e);
  assert.equal(refused.code, 'platform_form', 'ScopeDown does not file what HackerOne only takes in its form');
  const handed = await drafts.handOff(ok.result.draft_id, { by: 'user' });
  assert.equal(handed.status, 'handed_off');
  assert.equal(handed.handoff_url, 'https://hackerone.com/formonly/reports/new');
  const { getAdapter } = await import('../src/platforms/index.js');
  const fields = Object.fromEntries(getAdapter('hackerone').agent.formFields(handed));
  assert.equal(fields['Researcher IP Address'], '203.0.113.7');
  assert.equal(fields['Fraud Related?'], 'No');

  // HackerOne's form is filled in the opened tab, custom fields included, by their labels.
  const { getDraft } = await import('../src/agent/store.js');
  let filled;
  for (let i = 0; i < 50 && !filled?.prefill; i++) {
    await new Promise((r) => setTimeout(r, 10));
    filled = await getDraft(ok.result.draft_id);
  }
  const fill = requests.filter((r) => r.kind === 'fill-h1').at(-1).data;
  assert.equal(fill.title, 'Report to a program with custom fields');
  assert.deepEqual(fill.custom, [{ label: 'Researcher IP Address', value: '203.0.113.7' }, { label: 'Fraud Related?', value: 'No' }, { label: 'Terms and Conditions', value: true }]);
  assert.equal(fill.severity, handed.severity);
  assert.ok(fill.description.startsWith(handed.description));
  assert.equal(filled.prefill.missed.length, 0);
  assert.equal(filled.status, 'handed_off');
  assert.deepEqual(mutations(), [], 'filling the form sends nothing to HackerOne\'s API');
});

test('Bugcrowd: VRT entries by full path with priority, target ids, and the form handoff', async () => {
  const w = await dispatch('get_weaknesses', { platform: 'bugcrowd', handle: 'tesla', query: 'self' });
  const ids = w.result.weaknesses.map((x) => x.id);
  assert.ok(ids.includes('cross_site_scripting_xss.stored.self') && ids.includes('server_security_misconfiguration.self.varies'), 'same leaf id in two categories stays distinct');
  assert.equal(w.result.weaknesses.find((x) => x.id.startsWith('cross')).priority_label, 'P5');
  assert.equal(w.result.quota.weekly_remaining, 6);

  const req = await dispatch('get_report_requirements', { platform: 'bugcrowd', handle: 'tesla' });
  assert.equal(req.result.filing, 'platform_form');
  assert.equal(req.result.fields.weakness.required, true);
  assert.ok(req.result.assets.every((a) => a.id && a.id.startsWith('t-')), 'every in-scope asset maps to a Bugcrowd target id');

  const noVrt = await dispatch('draft_report', { platform: 'bugcrowd', handle: 'tesla', title: 'Stored XSS on the Tesla shop', asset: 'shop.tesla.cn', description: 'd'.repeat(100), impact: 'Script runs for every shopper.' }, null);
  assert.equal(noVrt.error.code, 'weakness_required');

  const d = await dispatch('draft_report', { platform: 'bugcrowd', handle: 'tesla', title: 'Stored XSS on the Tesla shop', asset: 'https://shop.tesla.cn/cart', weakness: 'stored anyone', url: 'https://shop.tesla.cn/cart', http_request: 'POST /cart HTTP/1.1\nHost: shop.tesla.cn', description: 'd'.repeat(100), impact: 'Script runs for every shopper.' }, null);
  assert.equal(d.ok, true, JSON.stringify(d.error));
  assert.equal(d.result.weakness, 'Cross-Site Scripting (XSS) > Stored > Non-Privileged User to Anyone (P2)');
  assert.equal(d.result.severity, 'high', 'severity follows the VRT priority when the agent leaves it out');
  assert.equal(d.result.filing, 'platform_form');
  const { getDraft } = await import('../src/agent/store.js');
  const stored = await getDraft(d.result.draft_id);
  assert.match(stored.asset.id, /^t-/);
  const { getAdapter } = await import('../src/platforms/index.js');
  const fields = Object.fromEntries(getAdapter('bugcrowd').agent.formFields(stored));
  assert.equal(fields['Vulnerability type (VRT)'], 'Cross-Site Scripting (XSS) > Stored > Non-Privileged User to Anyone (cross_site_scripting_xss.stored.non_admin_to_anyone, P2)');
  assert.equal(fields['URL / location of vulnerability'], 'https://shop.tesla.cn/cart');
  assert.match(fields.Description, /## Impact/);
  assert.match(Object.fromEntries(getAdapter('bugcrowd').agent.formFields({ ...stored, description: `See {{attachment:poc.png}}. ${'d'.repeat(90)}` })).Description, /See `poc.png` \(attached\)\./, 'evidence references become file names');
  assert.equal((await drafts.submitDraft(d.result.draft_id, { by: 'user' }).catch((e) => e)).code, 'platform_form');

  // Approving it opens Bugcrowd's form and fills it in that tab; nothing is submitted.
  const handed = await drafts.handOff(d.result.draft_id, { by: 'user' });
  assert.equal(handed.status, 'handed_off');
  assert.equal(handed.handoff_url, 'https://bugcrowd.com/engagements/tesla/submissions/new');
  let filled;
  for (let i = 0; i < 50 && !filled?.prefill; i++) {
    await new Promise((r) => setTimeout(r, 10));
    filled = await getDraft(d.result.draft_id);
  }
  const fill = requests.filter((r) => r.kind === 'fill').at(-1).data;
  assert.deepEqual([fill.title, fill.target.id, fill.vrt, fill.url, fill.request], ['Stored XSS on the Tesla shop', stored.asset.id, 'cross_site_scripting_xss.stored.non_admin_to_anyone', 'https://shop.tesla.cn/cart', 'POST /cart HTTP/1.1\nHost: shop.tesla.cn']);
  assert.match(fill.description, /## Impact\n\nScript runs for every shopper\./);
  assert.deepEqual(fill.files, []);
  assert.deepEqual(filled.prefill.filled, ['Summary title', 'Target', 'VRT', 'Description']);
  assert.deepEqual(filled.prefill.missed, ['URL: no URL field']);
  assert.equal(filled.history.at(-1).event, 'prefilled');
  assert.equal(filled.status, 'handed_off', 'filling the form does not submit anything');
  const pub = await dispatch('get_draft', { draft_id: d.result.draft_id });
  assert.deepEqual(pub.result.form_prefill.missed, ['URL: no URL field']);
});

async function pageThrough(op, args, key) {
  const seen = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const out = await dispatch(op, { platform: 'bugcrowd', ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    const page = out.result.bugcrowd;
    seen.push(...page[key]);
    cursor = page.next_cursor;
    if (!cursor) return { seen, last: page };
  }
  throw new Error('paging never ended');
}

test('Bugcrowd: your submissions page in order, with no gaps or repeats, drafts excluded', async () => {
  bcSubmissions.length = 0;
  for (let i = 1; i <= 60; i++) bcSubmissions.push({ reference_number: `r-${i}`, caption: `Finding ${i}`, substate: 'triaged', engagement_name: i % 2 ? 'Tesla' : 'Okta', engagement_code: i % 2 ? 'tesla' : 'okta', submission_url: `/submissions/r-${i}` });
  bcSubmissions.splice(3, 0, { reference_number: 'draft-1', caption: 'Unsent', draft: true });
  const { seen, last } = await pageThrough('list_my_reports', { limit: 7 }, 'reports');
  assert.deepEqual(seen.map((r) => r.id), Array.from({ length: 60 }, (_, i) => `r-${i + 1}`));
  assert.equal(last.total, 60);

  // A program filter matches the engagement code exactly, and returns codes get_program takes.
  const okta = (await dispatch('list_my_reports', { platform: 'bugcrowd', handle: 'okta', limit: 100 })).result.bugcrowd;
  assert.equal(okta.reports.length, 30);
  assert.ok(okta.reports.every((r) => r.program === 'okta'));
  assert.equal(okta.total, undefined, 'a filtered page does not claim the unfiltered total');
  assert.equal((await dispatch('list_my_reports', { platform: 'bugcrowd', handle: 'ok', limit: 100 })).result.bugcrowd.reports.length, 0);
  bcSubmissions.length = 0;
});

test('Bugcrowd: program search runs on the server and pages without gaps', async () => {
  bcEngagements.invite_only = [{ name: 'Alpha Private', briefUrl: '/engagements/alpha-private', isPrivate: true }, { name: 'Beta Private', briefUrl: '/engagements/beta-private', isPrivate: true }];
  bcEngagements.open = Array.from({ length: 70 }, (_, i) => ({ name: `${i % 2 ? 'Alpha' : 'Gamma'} Public ${i}`, briefUrl: `/engagements/public-${i}`, isPrivate: false }));
  const { seen, last } = await pageThrough('list_programs', { query: 'alpha', limit: 5 }, 'programs');
  assert.deepEqual(seen.map((p) => p.handle), ['alpha-private', ...bcEngagements.open.filter((e) => e.name.startsWith('Alpha')).map((e) => e.briefUrl.split('/').pop())]);
  assert.equal(last.total, 36);
  const invites = await pageThrough('list_programs', { limit: 1 }, 'programs');
  assert.deepEqual(invites.seen.map((p) => p.handle), ['alpha-private', 'beta-private']);
  bcEngagements.invite_only = []; bcEngagements.open = [];
});

test('HackerOne: private_only pages through every private program, none skipped', async () => {
  h1Teams.length = 0;
  for (let i = 0; i < 230; i++) h1Teams.push({ handle: `t${i}`, name: `Team ${i}`, state: i % 7 === 0 ? 'soft_launched' : 'public_mode', offers_bounties: true, submission_state: 'open' });
  const want = h1Teams.filter((t) => t.state === 'soft_launched').map((t) => t.handle);
  const seen = [];
  let cursor;
  for (let i = 0; i < 40; i++) {
    const out = await dispatch('list_programs', { platform: 'hackerone', private_only: true, limit: 4, ...(cursor ? { cursor } : {}) });
    assert.equal(out.error, undefined, JSON.stringify(out.error));
    seen.push(...out.result.hackerone.programs.map((p) => p.handle));
    cursor = out.result.hackerone.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, want);
  h1Teams.length = 0;
});

test('HackerOne: a bad cursor is a bad request, and signed out is signed out', async () => {
  h1Teams.push({ handle: 'a', name: 'A', state: 'public_mode' });
  assert.equal((await dispatch('list_programs', { platform: 'hackerone', cursor: 'garbage' })).error.code, 'bad_request');
  assert.equal((await dispatch('list_my_reports', { platform: 'hackerone', cursor: 'garbage' })).error.code, 'bad_request');
  assert.equal((await dispatch('search_disclosed_reports', { query: 'xss', cursor: 'garbage' })).error.code, 'bad_request');
  h1SignedOut = true;
  assert.equal((await dispatch('list_programs', { platform: 'hackerone' })).error.code, 'signed_out');
  h1SignedOut = false;
  h1Teams.length = 0;
});

test('get_my_report says whose report it is', async () => {
  const mine = (await dispatch('get_my_report', { platform: 'hackerone', id: '1' })).result;
  assert.equal(mine.yours, true);
  const other = (await dispatch('get_my_report', { platform: 'hackerone', id: '2' })).result;
  assert.equal(other.yours, false);
  assert.equal(other.reporter, 'someone-else');
});

test('an HTTP error with a JSON body is an error, never an empty list or a sign-out', async () => {
  httpError = 429;
  assert.equal((await dispatch('list_my_reports', { platform: 'bugcrowd' })).error.code, 'rate_limited');
  assert.equal((await dispatch('list_programs', { platform: 'bugcrowd', query: 'tesla' })).error.code, 'rate_limited');
  httpError = 503;
  const h1 = (await dispatch('list_my_reports', { platform: 'hackerone' })).error;
  assert.equal(h1.code, 'platform');
  assert.match(h1.message, /503/);
  httpError = null;
});

test('a missing evidence file loads as nothing, not as a truthy request object', async () => {
  const { loadFile } = await import('../src/agent/files.js');
  assert.equal(await loadFile('f_missing'), undefined);
});

test('drafts and log entries written at the same moment are all kept', async () => {
  const { putDraft, getDrafts, logActivity, getActivity } = await import('../src/agent/store.js');
  const before = (await getActivity()).length;
  const at = new Date().toISOString();
  await Promise.all(Array.from({ length: 20 }, (_, i) => putDraft({ id: `d_race${i}`, created_at: at, status: 'pending_review', history: [] })));
  await Promise.all(Array.from({ length: 10 }, (_, i) => logActivity({ op: `race${i}`, ok: true })));
  const drafts = await getDrafts();
  assert.equal(Array.from({ length: 20 }, (_, i) => `d_race${i}`).filter((id) => drafts[id]).length, 20);
  assert.equal((await getActivity()).length, Math.min(before + 10, 300));
  await chrome.storage.local.set({ drafts: Object.fromEntries(Object.entries(drafts).filter(([id]) => !id.startsWith('d_race'))) });
});

test('past 200 drafts only finished ones are dropped, never one still waiting', async () => {
  const { putDraft, getDrafts } = await import('../src/agent/store.js');
  const saved = await getDrafts();
  const old = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  const drafts = {};
  for (let i = 0; i < 5; i++) drafts[`d_wait${i}`] = { id: `d_wait${i}`, created_at: old(i), status: 'pending_review', history: [] };
  for (let i = 0; i < 200; i++) drafts[`d_done${i}`] = { id: `d_done${i}`, created_at: old(100 + i), status: 'submitted', history: [] };
  await chrome.storage.local.set({ drafts });
  await putDraft({ id: 'd_new', created_at: new Date().toISOString(), status: 'pending_review', history: [] });
  const kept = await getDrafts();
  assert.equal(Object.keys(kept).length, 200);
  for (let i = 0; i < 5; i++) assert.ok(kept[`d_wait${i}`], `d_wait${i} was dropped`);
  assert.ok(kept.d_new);
  await chrome.storage.local.set({ drafts: saved });
});

test('Submit files only the version the hunter reviewed', async () => {
  const { getDraft } = await import('../src/agent/store.js');
  const id = (await dispatch('draft_report', { ...report, title: 'Reviewed version only reaches HackerOne', severity: 'low' }, null)).result.draft_id;
  const reviewed = (await getDraft(id)).updated_at;
  await new Promise((r) => setTimeout(r, 5));
  await dispatch('update_draft', { draft_id: id, severity: 'critical', description: 'Changed after review. '.padEnd(120, 'y') }, { name: 'agent' });
  const before = mutations().length;
  await assert.rejects(drafts.submitDraft(id, { by: 'user', reviewed }), { code: 'changed' });
  assert.equal(mutations().length, before, 'nothing reached HackerOne');
  assert.equal((await getDraft(id)).status, 'pending_review');
  const now = (await getDraft(id)).updated_at;
  assert.equal((await drafts.submitDraft(id, { by: 'user', reviewed: now })).status, 'submitted');
});

test('a retried submit uploads evidence the agent replaced, not the first upload', async () => {
  const id = (await dispatch('draft_report', { ...report, title: 'Replaced evidence reaches HackerOne on retry' }, null)).result.draft_id;
  assert.equal((await attach(id, 'poc.png', Buffer.alloc(10, 1))).ok, true);
  refuseCreate = true;
  assert.equal((await drafts.submitDraft(id, { by: 'user' })).status, 'failed');
  refuseCreate = false;
  await dispatch('remove_attachment', { draft_id: id, attachment: 'poc.png' }, null);
  assert.equal((await attach(id, 'poc.png', Buffer.alloc(20, 2))).ok, true);
  const uploads = requests.filter((r) => r.kind === 'attach').length;
  assert.equal((await drafts.submitDraft(id, { by: 'user' })).status, 'submitted');
  const fresh = requests.filter((r) => r.kind === 'attach').slice(uploads);
  assert.deepEqual(fresh.map((r) => r.bytes), [20], 'the replacement was uploaded');
  assert.deepEqual(lastFiled.attachment_ids, [String(900 + requests.filter((r) => r.kind === 'attach').length)]);
});

test('auto-submit stops waiting when an announced file is refused, and the hunter is told', async () => {
  const { getDraft } = await import('../src/agent/store.js');
  await setSettings({ autoSubmit: ['hackerone:security'] });
  const filedBefore = filedTitles.length;

  const dup = (await dispatch('draft_report', { ...report, title: 'Auto-submit with two files of one name', attachments_pending: 2 }, null)).result.draft_id;
  assert.equal((await attach(dup, 'poc.png', Buffer.from('from /a'))).ok, true);
  assert.equal((await attach(dup, 'poc.png', Buffer.from('from /b'))).error.code, 'duplicate_file');

  const damaged = (await dispatch('draft_report', { ...report, title: 'Auto-submit with a damaged upload', attachments_pending: 1 }, null)).result.draft_id;
  const begin = await dispatch('attach_begin', { draft_id: damaged, name: 'x.png', size: 3, sha256: '0'.repeat(64) }, null);
  await dispatch('attach_chunk', { upload_id: begin.result.upload_id, index: 0, data: Buffer.from('abc').toString('base64') }, null);
  assert.equal((await dispatch('attach_end', { upload_id: begin.result.upload_id }, null)).error.code, 'bad_file');

  for (const id of [dup, damaged]) {
    const d = await getDraft(id);
    assert.equal(d.status, 'pending_review');
    assert.equal(d.auto_submit_after_files, undefined, `${id} still waits for files`);
    assert.ok(d.history.some((h) => /auto-submit stopped/.test(h.event)));
    assert.ok(notes.some((n) => n.id === `draft:${id}`), `no notification for ${id}`);
  }
  assert.equal(filedTitles.length, filedBefore, 'nothing was filed without its evidence');
  await setSettings({ autoSubmit: [] });
});

test('status lists every platform with its capabilities', async () => {
  const st = await dispatch('status', {});
  assert.deepEqual(st.result.platforms.map((p) => [p.id, p.direct_filing, p.disclosed_search]), [['hackerone', true, true], ['bugcrowd', false, false]]);
  const unsupported = await dispatch('search_disclosed_reports', { platform: 'bugcrowd' });
  assert.equal(unsupported.error.code, 'unsupported');
  assert.equal((await dispatch('get_program', { platform: 'yeswehack', handle: 'x' })).error.code, 'bad_request');
});

test('the affected URL must sit inside the program scope', async () => {
  const out = await dispatch('draft_report', { ...report, title: 'URL outside the scope of the program', url: 'https://support.hackerone.com/x' }, null);
  assert.equal(out.error.code, 'not_in_scope');
  const unlisted = await dispatch('draft_report', { ...report, title: 'URL not covered by any listed asset', url: 'https://docs.hackerone.com/x' }, null);
  assert.equal(unlisted.error.code, 'not_in_scope');
  const ok = await dispatch('draft_report', { ...report, title: 'URL inside the scope of the program', url: 'https://hackerone.com/reports/1' }, null);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
});
