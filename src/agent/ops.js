// The only operations an agent can run. Each one validates its parameters again (the MCP
// server's schema is a convenience, not a guarantee) and calls a platform adapter, which only
// makes fixed requests. Nothing here names a platform: adapters come from the registry.

import { ADAPTERS, getAdapter } from '../platforms/index.js';
import { checkScope } from './scope.js';
import { RunnerError } from './runner.js';
import { createDraft, updateDraft, waitForDecision, publicDraft, addAttachment, removeAttachment, stopAutoSubmit } from './drafts.js';
import { beginUpload, addChunk, finishUpload, uploadDraft } from './files.js';
import { sweep, waitSweep, sweepStatus, listEvents, byProgram, KINDS, CATEGORIES, SEVERITIES, BACKFILL_DAYS } from './watch.js';

// Runs one step of an upload. If it fails, an auto-submit draft stops waiting for the file.
async function failing(draftId, step) {
  try {
    return await step();
  } catch (e) {
    if (draftId) await stopAutoSubmit(draftId, e.message).catch(() => {});
    throw e;
  }
}
import { getSettings, getDrafts, logActivity } from './store.js';

const STATUSES = ['pending_review', 'submitting', 'submitted', 'rejected', 'handed_off', 'failed'];

const v = {
  adapter(id, { optional = false } = {}) {
    if (id === undefined && optional) return undefined;
    const a = getAdapter(id);
    if (!a) throw new RunnerError('bad_request', `platform must be one of: ${ADAPTERS.map((x) => x.id).join(', ')}.`);
    return a;
  },
  handle(h, { optional = false } = {}) {
    if (h === undefined && optional) return undefined;
    if (typeof h !== 'string' || !/^[\w.-]{1,120}$/.test(h)) throw new RunnerError('bad_request', 'handle must be the program handle from its URL.');
    return h;
  },
  int(n, min, max, fallback) {
    if (n === undefined) return fallback;
    if (!Number.isInteger(n) || n < min || n > max) throw new RunnerError('bad_request', `Expected a whole number from ${min} to ${max}.`);
    return n;
  },
  // "7d", "24h" or an ISO date, as an ISO timestamp.
  when(x, fallback) {
    if (x === undefined) return fallback;
    const m = /^(\d{1,4})([hd])$/.exec(String(x));
    const t = m ? Date.now() - Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000) : Date.parse(x);
    if (typeof x !== 'string' || x.length > 40 || !Number.isFinite(t)) throw new RunnerError('bad_request', 'Times are "7d", "24h" or an ISO date such as 2026-11-01.');
    return new Date(t).toISOString();
  },
  oneOf(x, list, name) {
    if (x === undefined) return undefined;
    if (!list.includes(x)) throw new RunnerError('bad_request', `${name} must be one of: ${list.join(', ')}.`);
    return x;
  },
  some(xs, list, name) {
    if (xs === undefined) return undefined;
    if (!Array.isArray(xs) || xs.length > list.length || xs.some((x) => !list.includes(x))) throw new RunnerError('bad_request', `${name} takes a list of: ${list.join(', ')}.`);
    return xs;
  },
  str(s, max, { optional = true } = {}) {
    if (s === undefined && optional) return undefined;
    if (typeof s !== 'string' || s.length > max) throw new RunnerError('bad_request', `Expected text of at most ${max} characters.`);
    return s;
  },
};

function capabilities(a) {
  return {
    id: a.id,
    label: a.label,
    direct_filing: Boolean(a.agent.file),
    disclosed_search: Boolean(a.agent.disclosed),
    report_threads: Boolean(a.agent.myReport),
    weakness_kind: a.weaknessLabel,
  };
}

// build(program) turns a normalized program into the Markdown bundle; the background page
// supplies it because it needs a DOM for HTML briefs.
export function createOps({ build }) {
  const allowed = async (a) => {
    const s = await getSettings();
    if (s.platforms[a.id] === false) throw new RunnerError('platform_disabled', `The user turned off agent access to ${a.label}.`);
  };
  // One call per platform the agent asked about; with no platform every platform answers, and
  // one platform's failure does not hide the others.
  const each = async (p, fn) => {
    const one = v.adapter(p.platform, { optional: true });
    // Platforms answer independently, so ask them together; results keep the adapter order.
    return Object.fromEntries(await Promise.all((one ? [one] : ADAPTERS).map(async (a) => {
      try {
        await allowed(a);
        return [a.id, await fn(a)];
      } catch (e) {
        if (one) throw e;
        return [a.id, { error: e.message }];
      }
    })));
  };

  const ops = {
    async status() {
      const s = await getSettings();
      const drafts = Object.values(await getDrafts());
      // Each platform answers on its own clock, so ask them together.
      const accounts = Object.fromEntries(await Promise.all(ADAPTERS.map(async (a) => {
        if (s.platforms[a.id] === false) return [a.id, { allowed: false }];
        try {
          return [a.id, { allowed: true, ...(await a.agent.account()) }];
        } catch (e) {
          return [a.id, { allowed: true, signed_in: null, error: e.message }];
        }
      })));
      return {
        extension: ext().runtime.getManifest().version,
        platforms: ADAPTERS.map(capabilities),
        accounts,
        auto_submit: s.autoSubmit,
        drafts_waiting: drafts.filter((d) => d.status === 'pending_review').length,
        note: 'Drafts wait for the user\'s approval in the browser, except on programs listed in auto_submit.',
      };
    },

    async list_programs(p) {
      const args = { privateOnly: Boolean(p.private_only), query: v.str(p.query, 100), limit: v.int(p.limit, 1, 100, 25), cursor: v.str(p.cursor, 300) };
      if (args.cursor && !p.platform) throw new RunnerError('bad_request', 'Pass platform together with that platform\'s next_cursor.');
      return each(p, (a) => a.agent.listPrograms(args));
    },

    async list_scope_changes(p) {
      const one = v.adapter(p.platform, { optional: true });
      if (one) await allowed(one);
      const handle = v.handle(p.handle, { optional: true });
      if (handle && !one) throw new RunnerError('bad_request', 'Pass platform together with handle.');
      const settings = await getSettings();
      const platforms = (one ? [one] : ADAPTERS).filter((a) => a.agent.watch && settings.platforms[a.id] !== false).map((a) => a.id);
      const filters = {
        handle,
        since: v.when(p.since, v.when('7d')),
        until: v.when(p.until, undefined),
        kinds: v.some(p.kinds, KINDS, 'kinds'),
        categories: v.some(p.asset_types, CATEGORIES, 'asset_types'),
        visibility: v.oneOf(p.visibility, ['public', 'private'], 'visibility'),
        min_severity: v.oneOf(p.min_severity, SEVERITIES, 'min_severity'),
        in_scope_only: Boolean(p.in_scope_only),
        bounty_only: Boolean(p.bounty_only),
        query: v.str(p.query, 100),
      };
      const group = v.oneOf(p.group_by, ['program'], 'group_by');
      const limit = v.int(p.limit, 1, 200, 50);
      const from = p.cursor === undefined ? 0 : Number(v.str(p.cursor, 10));
      if (!Number.isInteger(from) || from < 0) throw new RunnerError('bad_request', 'Unknown cursor. Pass next_cursor from the previous page.');
      // A new page reads what the first call found; it does not start another check.
      if (p.refresh !== false && p.cursor === undefined && platforms.length) sweep({ platforms }).catch(() => {});
      await waitSweep(v.int(p.wait_seconds, 0, 50, 0) * 1000);

      const events = (await Promise.all(platforms.map((id) => listEvents({ ...filters, platform: id })))).flat()
        .sort((x, y) => y.at.localeCompare(x.at) || x.id.localeCompare(y.id));
      const rows = group ? byProgram(events) : events;
      const page = rows.slice(from, from + limit);
      const status = await sweepStatus();
      const watching = Object.values(status.platforms).map((x) => x.watching_since).filter(Boolean).sort()[0];
      return {
        checking: status.state === 'running',
        sweep: status,
        total: rows.length,
        [group ? 'programs' : 'changes']: page,
        next_cursor: from + limit < rows.length ? String(from + limit) : null,
        note: [
          status.state === 'running' ? 'ScopeDown is still checking the platforms, so more changes can appear. Call again with refresh false in a minute.' : null,
          watching ? `Watching since ${watching}. New assets are dated by the platform up to ${BACKFILL_DAYS} days before that; removals and edits are known from then on.` : null,
          'dated_by "platform" means the platform dated the change; "scopedown" means when ScopeDown noticed it. Read the program with get_program and run check_scope before testing a new asset.',
        ].filter(Boolean).join(' '),
      };
    },

    async get_program(p) {
      const a = v.adapter(p.platform);
      const handle = v.handle(p.handle);
      await allowed(a);
      const program = await a.agent.program(handle);
      const built = await build(program);
      if (p.format === 'json') return summary(program, built);
      return { markdown: built.markdown };
    },

    async check_scope(p) {
      const a = v.adapter(p.platform);
      const handle = v.handle(p.handle);
      if (!Array.isArray(p.targets) || !p.targets.length || p.targets.length > 200) throw new RunnerError('bad_request', 'targets must list 1 to 200 hosts, URLs or ranges.');
      await allowed(a);
      const program = await a.agent.program(handle);
      return {
        program: program.name,
        results: p.targets.map((t) => checkScope(program.scopes, v.str(t, 2048, { optional: false }))),
        reminder: 'in_scope covers the asset, not every technique. Follow the program\'s key rules (get_program).',
      };
    },

    async get_report_requirements(p) {
      const a = v.adapter(p.platform);
      const handle = v.handle(p.handle);
      await allowed(a);
      return { platform: a.id, program: handle, weakness_kind: a.weaknessLabel, ...(await a.agent.requirements(handle)) };
    },

    async get_weaknesses(p) {
      const a = v.adapter(p.platform);
      const handle = v.handle(p.handle);
      await allowed(a);
      return a.agent.weaknesses(handle, { query: v.str(p.query, 100), limit: v.int(p.limit, 1, 50, 20), cursor: v.str(p.cursor, 300) });
    },

    async search_disclosed_reports(p) {
      const a = v.adapter(p.platform ?? ADAPTERS.find((x) => x.agent.disclosed)?.id);
      if (!a.agent.disclosed) throw new RunnerError('unsupported', `${a.label} has no public disclosed-report search.`);
      await allowed(a);
      return a.agent.disclosed({ handle: v.handle(p.handle, { optional: true }), query: v.str(p.query, 200), limit: v.int(p.limit, 1, 50, 10), cursor: v.str(p.cursor, 20) });
    },

    async list_my_reports(p) {
      const args = { handle: v.handle(p.handle, { optional: true }), limit: v.int(p.limit, 1, 100, 25), cursor: v.str(p.cursor, 300) };
      if (args.cursor && !p.platform) throw new RunnerError('bad_request', 'Pass platform together with that platform\'s next_cursor.');
      return each(p, (a) => a.agent.myReports(args));
    },

    async get_my_report(p) {
      const a = v.adapter(p.platform);
      if (!a.agent.myReport) throw new RunnerError('unsupported', `${a.label} reports cannot be read in full yet. Use list_my_reports.`);
      if (!/^[\w-]{1,40}$/.test(String(p.id))) throw new RunnerError('bad_request', 'id must be the report number.');
      await allowed(a);
      return a.agent.myReport(String(p.id), { cursor: v.str(p.thread_cursor, 300) });
    },

    async draft_report(p, client) {
      const a = v.adapter(p.platform);
      v.handle(p.handle);
      await allowed(a);
      const draft = await createDraft(p, client);
      const req = await a.agent.requirements(p.handle);
      return { ...publicDraft(draft), ...(req.quota ? { quota: req.quota } : {}) };
    },

    async update_draft(p, client) {
      const id = v.str(p.draft_id, 64, { optional: false });
      return publicDraft(await updateDraft(id, p, client?.name || 'agent'));
    },

    async get_draft(p) {
      const id = v.str(p.draft_id, 64, { optional: false });
      return publicDraft(await waitForDecision(id, v.int(p.wait_seconds, 0, 600, 0)));
    },

    async list_drafts(p) {
      if (p.status !== undefined && !STATUSES.includes(p.status)) throw new RunnerError('bad_request', `status must be one of ${STATUSES.join(', ')}.`);
      const limit = v.int(p.limit, 1, 100, 25);
      const from = Number(v.str(p.cursor, 10)) || 0;
      const all = Object.values(await getDrafts())
        .filter((d) => !p.status || d.status === p.status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { total: all.length, drafts: all.slice(from, from + limit).map(publicDraft), next_cursor: from + limit < all.length ? String(from + limit) : null };
    },

    // Evidence files arrive in chunks: native messaging caps each message at 1 MB.
    async attach_begin(p) {
      const id = v.str(p.draft_id, 64, { optional: false });
      const draft = await waitForDecision(id, 0);
      if (!['pending_review', 'rejected', 'failed'].includes(draft.status)) throw new RunnerError('locked', `Draft ${id} is ${draft.status}.`);
      return failing(id, () => beginUpload({ draftId: id, name: p.name, size: p.size, sha: p.sha256 }));
    },

    async attach_chunk(p) {
      const uploadId = v.str(p.upload_id, 40, { optional: false });
      return failing(uploadDraft(uploadId), () => addChunk({ uploadId, index: v.int(p.index, 0, 100, undefined), data: v.str(p.data, 800_000, { optional: false }) }));
    },

    async attach_end(p, client) {
      const uploadId = v.str(p.upload_id, 40, { optional: false });
      const { meta, draftId } = await failing(uploadDraft(uploadId), () => finishUpload({ uploadId, by: client?.name || 'agent' }));
      return publicDraft(await addAttachment(draftId, meta));
    },

    async remove_attachment(p, client) {
      return publicDraft(await removeAttachment(v.str(p.draft_id, 64, { optional: false }), v.str(p.attachment, 200, { optional: false }), client?.name || 'agent'));
    },
  };

  // Runs one operation and records it in the activity log.
  return async function dispatch(op, params = {}, client = null) {
    const started = Date.now();
    const entry = { op, client: client?.name || 'agent', platform: params?.platform, program: params?.handle };
    try {
      if (!Object.hasOwn(ops, op)) throw new RunnerError('unknown_op', `Unknown operation "${op}".`);
      if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new RunnerError('bad_request', 'Parameters must be an object.');
      const result = await ops[op](params, client);
      // File chunks would flood the log; the finished upload is logged instead.
      if (op !== 'attach_chunk' && op !== 'attach_begin') await logActivity({ ...entry, ok: true, ms: Date.now() - started, detail: detail(op, params, result) });
      return { ok: true, result };
    } catch (e) {
      const code = e instanceof RunnerError ? e.code : 'internal';
      await logActivity({ ...entry, ok: false, ms: Date.now() - started, detail: `${code}: ${e.message}`.slice(0, 300) });
      return { ok: false, error: { code, message: e.message } };
    }
  };
}

function ext() {
  return globalThis.browser ?? globalThis.chrome;
}

// A one-line description for the activity log, never the report text itself.
function detail(op, p, r) {
  if (op === 'check_scope') return r.results.map((x) => `${x.target}: ${x.verdict}`).join(', ').slice(0, 300);
  if (['draft_report', 'update_draft', 'get_draft', 'remove_attachment'].includes(op)) return `${r.draft_id}: ${r.status}`;
  if (op === 'attach_end') return `${r.draft_id}: ${r.attachments.at(-1)?.name}`;
  if (op === 'list_programs' || op === 'list_my_reports') return Object.entries(r).map(([k, x]) => `${k}: ${x.programs?.length ?? x.reports?.length ?? 0}`).join(', ');
  if (op === 'get_weaknesses') return p.query ? `"${String(p.query).slice(0, 60)}"` : '';
  if (op === 'get_report_requirements') return `${r.filing}${r.custom_fields?.length ? `, ${r.custom_fields.length} custom fields` : ''}`;
  if (op === 'search_disclosed_reports') return `${r.reports.length} results`;
  if (op === 'list_scope_changes') return `${r.total} changes${r.checking ? ', still checking' : ''}`;
  return '';
}

function summary(p, built) {
  const pick = (s) => ({
    asset: s.identifier,
    type: s.type || undefined,
    location: s.location || undefined,
    group: s.group || undefined,
    bounty: s.bounty ?? undefined,
    max_severity: s.maxSeverity || undefined,
  });
  return {
    platform: p.platform,
    handle: p.handle,
    name: p.name,
    url: p.url,
    visibility: p.visibility,
    submissions: p.status,
    offers_bounties: p.bounties,
    top_reward: built.topReward?.label || null,
    rules: built.rules.map((r) => ({ topic: r.label, value: r.short.mono ? r.short.value : undefined, quotes: r.lines })),
    in_scope: p.scopes.filter((s) => s.inScope).map(pick),
    out_of_scope: p.scopes.filter((s) => !s.inScope).map(pick),
    targets: built.targets,
    note: 'Call get_program with format "markdown" for the full policy text, and get_report_requirements before drafting.',
  };
}
