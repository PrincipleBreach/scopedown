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
function answerGraphql(query, variables) {
  if (/createReport\(input/.test(query)) {
    filedTitles.push({ title: variables.input.title, at: new Date().toISOString() });
    return { createReport: { was_successful: true, errors: { edges: [] }, report: { _id: '4242', url: 'https://hackerone.com/reports/4242' } } };
  }
  if (/ScopeDownMyReports/.test(query)) {
    return { me: { reports: { total_count: filedTitles.length, pageInfo: { hasNextPage: false }, nodes: filedTitles.map((f, i) => ({ _id: String(5150 + i), title: f.title, substate: 'new', created_at: f.at, url: `https://hackerone.com/reports/${5150 + i}`, team: { handle: 'security' } })) } } };
  }
  if (/team_weaknesses/.test(query)) return { team: { team_weaknesses: { total_count: 1, nodes: [{ instruction: null, weakness: { id: Buffer.from('gid://hackerone/Weakness/60').toString('base64'), name: 'Cross-site Scripting (XSS) - Stored', external_id: 'cwe-79' } }] } } };
  if (/me \{ username/.test(query)) return { me: { username: 'tester' } };
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
  for (let i = 1; i <= 60; i++) bcSubmissions.push({ reference_number: `r-${i}`, caption: `Finding ${i}`, substate: 'triaged', engagement_name: i % 2 ? 'Tesla' : 'Okta', submission_url: `/submissions/r-${i}` });
  bcSubmissions.splice(3, 0, { reference_number: 'draft-1', caption: 'Unsent', draft: true });
  const { seen, last } = await pageThrough('list_my_reports', { limit: 7 }, 'reports');
  assert.deepEqual(seen.map((r) => r.id), Array.from({ length: 60 }, (_, i) => `r-${i + 1}`));
  assert.equal(last.total, 60);
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
