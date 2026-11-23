// Report drafts written by agents. A draft is validated against the live program and its
// report requirements when it is created, then waits for the hunter. Only submitDraft() sends
// anything to a platform, and only the console's Submit button (a human click), a per-program
// auto-submit setting, or the resume after a restart calls it.
// Platform specifics live in the adapters (src/platforms); nothing here names a platform.

import { getAdapter } from '../platforms/index.js';
import { checkScope } from './scope.js';
import { RunnerError } from './runner.js';
import { getSettings, getDraft, getDrafts, putDraft, removeDraft } from './store.js';
import { loadFile, deleteFile, toBase64, MAX_FILES } from './files.js';

const ext = globalThis.browser ?? globalThis.chrome;
export const MAX_PENDING = 20;
export const EDITABLE = ['pending_review', 'rejected', 'failed'];
const SEVERITIES = ['none', 'low', 'medium', 'high', 'critical'];

export function adapterFor(platform) {
  const a = getAdapter(platform);
  if (!a) throw new RunnerError('bad_request', `Unknown platform "${platform}".`);
  return a;
}

export async function createDraft(params, client) {
  const pending = Object.values(await getDrafts()).filter((d) => d.status === 'pending_review').length;
  if (pending >= MAX_PENDING) {
    throw new RunnerError('too_many_drafts', `${pending} drafts are already waiting for review. Wait for the user before drafting more.`);
  }
  const fields = await validate(params.platform, params.handle, params);
  const now = new Date().toISOString();
  const draft = {
    id: `d_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    created_at: now,
    updated_at: now,
    platform: params.platform,
    handle: params.handle,
    ...fields,
    status: 'pending_review',
    source: client?.name || 'agent',
    history: [{ at: now, event: 'created', by: client?.name || 'agent' }],
  };
  await putDraft(draft);

  const settings = await getSettings();
  if (draft.mode.filing === 'direct' && settings.autoSubmit.includes(`${draft.platform}:${draft.handle}`)) {
    // With files on the way, auto-submit waits for the last one (see addAttachment).
    const pendingFiles = Math.min(Number(params.attachments_pending) || 0, MAX_FILES);
    if (!pendingFiles) return submitDraft(draft.id, { by: 'auto-submit' });
    return putDraft({ ...draft, auto_submit_after_files: pendingFiles });
  }
  await announce(draft);
  return draft;
}

export async function updateDraft(id, params, by) {
  const draft = await getDraft(id);
  if (!draft) throw new RunnerError('not_found', `No draft ${id}.`);
  if (!EDITABLE.includes(draft.status)) throw new RunnerError('locked', `Draft ${id} is ${draft.status} and can no longer change.`);
  const merged = {
    title: draft.title,
    asset: draft.asset?.identifier,
    weakness: draft.weakness?.id,
    severity: draft.severity,
    cvss_vector: draft.cvss_vector,
    url: draft.url,
    http_request: draft.http_request,
    description: draft.description,
    impact: draft.impact,
    custom_fields: Object.fromEntries((draft.custom_fields || []).map((c) => [c.key, c.value])),
  };
  for (const k of Object.keys(merged)) {
    if (params[k] === undefined) continue;
    merged[k] = k === 'custom_fields' ? { ...merged.custom_fields, ...params.custom_fields } : params[k];
  }
  const fields = await validate(draft.platform, draft.handle, merged);
  const now = new Date().toISOString();
  const next = {
    ...draft,
    ...fields,
    status: by === 'user' ? draft.status : 'pending_review',
    error: by === 'user' ? draft.error : null,
    updated_at: now,
    history: [...draft.history, { at: now, event: 'edited', by }],
  };
  await putDraft(next);
  if (by !== 'user' && draft.status !== 'pending_review') await announce(next);
  return next;
}

// Sends a draft to the platform, through the adapter's file(). Callers: the console's Submit
// button, createDraft for programs on the auto-submit list, and resumeInterrupted.
export async function submitDraft(id, { by, reviewed }) {
  const draft = await getDraft(id);
  if (!draft) throw new RunnerError('not_found', `No draft ${id}.`);
  // The console sends the version the hunter read. An agent may have revised the draft since.
  if (reviewed && draft.updated_at !== reviewed) {
    throw new RunnerError('changed', 'The agent changed this draft after you opened it. Read the new version, then submit again.');
  }
  const adapter = adapterFor(draft.platform);
  const resuming = draft.status === 'submitting' && by === 'resume';
  if (!resuming && !['pending_review', 'failed'].includes(draft.status)) throw new RunnerError('locked', `Draft ${id} is ${draft.status}.`);
  if (draft.mode?.filing !== 'direct' || !adapter.agent.file) {
    throw new RunnerError('platform_form', `This draft is finished in ${adapter.label}'s own form. ${draft.mode?.note || ''}`.trim());
  }
  if (!resuming) await putDraft(step(draft, 'submitting', by));
  await updateBadge();
  try {
    const out = await adapter.agent.file(await getDraft(id), { files: await filesFor(draft), progress: (filing) => remember(id, filing) });
    return await putDraft({ ...step(await getDraft(id), 'submitted', by), report: { id: out.report_id, url: out.url } });
  } catch (e) {
    return await putDraft({ ...step(await getDraft(id), 'failed', by), error: e.message });
  } finally {
    await updateBadge();
  }
}

// A worker restart in the middle of filing leaves drafts in "submitting". They resume from the
// last finished step, so nothing is uploaded or filed twice.
export async function resumeInterrupted() {
  for (const d of Object.values(await getDrafts())) {
    if (d.status === 'submitting') submitDraft(d.id, { by: 'resume' });
  }
}

async function remember(id, filing) {
  await putDraft({ ...(await getDraft(id)), filing });
}

// Attachment bytes for the platform upload.
async function filesFor(draft) {
  const out = [];
  for (const a of draft.attachments || []) {
    const f = await loadFile(a.id);
    if (f) out.push({ id: a.id, name: f.name, type: f.type, base64: toBase64(f.bytes) });
  }
  return out;
}

// An auto-submit draft waits for the files its agent announced. When one of them fails, it stops
// waiting and goes to the hunter instead: a report must not go out without its evidence, and
// a counter that never reaches zero would leave it unfiled with nobody told.
export async function stopAutoSubmit(draftId, reason) {
  const draft = await getDraft(draftId);
  if (!draft?.auto_submit_after_files) return;
  const at = new Date().toISOString();
  const next = await putDraft({ ...draft, auto_submit_after_files: undefined, history: [...draft.history, { at, event: `auto-submit stopped: ${reason}`.slice(0, 200), by: 'scopedown' }] });
  await announce(next);
}

// The file's bytes are already stored under meta.id; they are dropped again if it is refused.
export async function addAttachment(draftId, meta) {
  const draft = await getDraft(draftId);
  const refuse = async (code, message) => {
    await deleteFile(meta.id).catch(() => {});
    await stopAutoSubmit(draftId, message);
    throw new RunnerError(code, message);
  };
  if (!draft) return refuse('not_found', `No draft ${draftId}.`);
  if (!EDITABLE.includes(draft.status)) return refuse('locked', `Draft ${draftId} is ${draft.status}.`);
  const list = draft.attachments || [];
  if (list.length >= MAX_FILES) return refuse('too_many_files', `A draft holds at most ${MAX_FILES} files.`);
  if (list.some((a) => a.name === meta.name)) return refuse('duplicate_file', `${meta.name} is already attached. Rename it or remove the old one.`);
  const now = new Date().toISOString();
  const waiting = draft.auto_submit_after_files ? draft.auto_submit_after_files - 1 : 0;
  const saved = await putDraft({ ...draft, attachments: [...list, meta], auto_submit_after_files: waiting || undefined, updated_at: now, history: [...draft.history, { at: now, event: `attached ${meta.name}`, by: meta.added_by }] });
  if (draft.auto_submit_after_files && !waiting) return submitDraft(draftId, { by: 'auto-submit' });
  return saved;
}

export async function removeAttachment(draftId, fileId, by) {
  const draft = await getDraft(draftId);
  if (!draft) throw new RunnerError('not_found', `No draft ${draftId}.`);
  if (!EDITABLE.includes(draft.status)) throw new RunnerError('locked', `Draft ${draftId} is ${draft.status}.`);
  const target = (draft.attachments || []).find((a) => a.id === fileId || a.name === fileId);
  if (!target) throw new RunnerError('not_found', `No attachment ${fileId} on draft ${draftId}.`);
  await deleteFile(target.id);
  const now = new Date().toISOString();
  return putDraft({ ...draft, attachments: draft.attachments.filter((a) => a !== target), updated_at: now, history: [...draft.history, { at: now, event: `removed ${target.name}`, by }] });
}

// Opens the platform's own report form. The console copies the fields for the hunter.
// Opens the platform's own form for the hunter to finish, and fills it where the adapter
// can. Calling it again on a handed-off draft reopens and refills the form.
export async function handOff(id, { by }) {
  let draft = await getDraft(id);
  if (!draft) throw new RunnerError('not_found', `No draft ${id}.`);
  if (!['pending_review', 'failed', 'rejected', 'handed_off'].includes(draft.status)) throw new RunnerError('locked', `Draft ${id} is ${draft.status}.`);
  const adapter = adapterFor(draft.platform);
  if (draft.status !== 'handed_off') {
    draft = await putDraft({ ...step(draft, 'handed_off', by), handed_off_at: new Date().toISOString(), handoff_url: adapter.agent.formUrl(draft.handle) });
    await updateBadge();
  }
  if (adapter.agent.prefill) draft = await putDraft({ ...draft, prefill: null });
  const tab = await ext.tabs.create({ url: draft.handoff_url });
  // Not awaited: the console shows the result when it lands.
  if (adapter.agent.prefill) prefillForm(tab.id, draft.id, adapter.agent.prefill).catch(() => {});
  return draft;
}

// Files travel into the page as base64 arguments, so very large evidence stays a manual step.
const MAX_PREFILL_BYTES = 25 * 1024 * 1024;

async function prefillForm(tabId, id, prefill) {
  let result;
  try {
    await tabLoaded(tabId);
    const draft = await getDraft(id);
    const files = [];
    const skipped = [];
    let total = 0;
    for (const a of draft.attachments || []) {
      const f = await loadFile(a.id);
      if (!f || total + f.size > MAX_PREFILL_BYTES) {
        skipped.push(`${a.name}: attach it by hand`);
        continue;
      }
      total += f.size;
      files.push({ name: a.name, type: a.type, base64: toBase64(f.bytes) });
    }
    const [out] = await ext.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: prefill.func, args: prefill.args(draft, files) });
    const r = out?.result;
    result = r?.error ? { filled: [], missed: skipped, error: r.error } : { filled: r?.filled || [], missed: [...(r?.missed || []), ...skipped] };
  } catch (e) {
    result = { filled: [], missed: [], error: String(e?.message || e) };
  }
  const current = await getDraft(id);
  if (!current) return null;
  const at = new Date().toISOString();
  return putDraft({ ...current, prefill: { at, ...result }, history: [...current.history, { at, event: result.error ? 'prefill failed' : 'prefilled', by: 'scopedown' }] });
}

function tabLoaded(tabId, ms = 30_000) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      ext.tabs.onUpdated.removeListener(listener);
    };
    const timer = setTimeout(() => { done(); reject(new Error('The form did not finish loading.')); }, ms);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { done(); resolve(); }
    };
    ext.tabs.onUpdated.addListener(listener);
    // Covers a load that finished before the listener was attached.
    ext.tabs.get(tabId).then((t) => {
      if (t.status === 'complete' && t.url && !t.url.startsWith('about:')) { done(); resolve(); }
    }, () => {});
  });
}

export async function rejectDraft(id, note, { by }) {
  const draft = await getDraft(id);
  if (!draft) throw new RunnerError('not_found', `No draft ${id}.`);
  if (!EDITABLE.includes(draft.status)) throw new RunnerError('locked', `Draft ${id} is ${draft.status}.`);
  const next = await putDraft({ ...step(draft, 'rejected', by), review_note: String(note || '').slice(0, 2000) || null });
  await updateBadge();
  return next;
}

export async function deleteDraft(id) {
  const gone = await removeDraft(id);
  for (const a of gone?.attachments || []) await deleteFile(a.id).catch(() => {});
  await updateBadge();
}

// Waits for the hunter's decision on a draft, up to `seconds`.
export async function waitForDecision(id, seconds) {
  let draft = await getDraft(id);
  if (!draft) throw new RunnerError('not_found', `No draft ${id}.`);
  if (draft.status === 'handed_off') draft = await reconcile(draft);
  if (!seconds || !['pending_review', 'submitting'].includes(draft.status)) return draft;
  return new Promise((resolve) => {
    const finish = async () => {
      ext.storage.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve(await getDraft(id));
    };
    const listener = (changes, area) => {
      const d = area === 'local' && changes.drafts?.newValue?.[id];
      if (d && !['pending_review', 'submitting'].includes(d.status)) finish();
    };
    const timer = setTimeout(finish, seconds * 1000);
    ext.storage.onChanged.addListener(listener);
  });
}

// A handed-off draft counts as submitted once the hunter's report with its title shows up.
async function reconcile(draft) {
  try {
    const hit = await adapterFor(draft.platform).agent.findFiled(draft, draft.handed_off_at);
    if (!hit) return draft;
    return await putDraft({ ...step(draft, 'submitted', 'user'), report: hit });
  } catch {
    return draft;
  }
}

// Checks a draft against the program's live report requirements (see the adapters'
// requirements()), and returns the normalized fields to store.
async function validate(platform, handle, p) {
  const adapter = adapterFor(platform);
  const [req, prog] = await Promise.all([adapter.agent.requirements(handle), adapter.agent.program(handle)]);
  if (!req.can_submit) throw new RunnerError('closed', req.blocked_reason || `${prog.name} is not accepting submissions from this account.`);

  const weakness = p.weakness ? await adapter.agent.resolveWeakness(handle, p.weakness) : null;
  if (!weakness && req.fields.weakness?.required) {
    throw new RunnerError('weakness_required', `${prog.name} requires a ${adapter.weaknessLabel}. Find one with get_weaknesses.`);
  }
  const severity = p.severity || adapter.agent.severityFor?.(weakness) || null;
  if (!SEVERITIES.includes(severity)) throw new RunnerError('bad_request', 'severity must be none, low, medium, high or critical.');
  const custom = customFields(req.custom_fields || [], p.custom_fields);
  const direct = req.filing === 'direct' && Boolean(adapter.agent.file) && custom.length === 0;
  const url = p.url ? webUrl(p.url) : null;
  if (url && prog.scopes.some((s) => s.inScope)) {
    const verdict = checkScope(prog.scopes, url);
    if (verdict.verdict !== 'in_scope') {
      throw new RunnerError('not_in_scope', `url ${url} is ${verdict.verdict === 'out_of_scope' ? `out of scope (${verdict.asset})` : 'not covered by any in-scope asset'}. Use the URL where the issue occurs on the in-scope asset.`);
    }
  }

  return {
    program: { name: prog.name, url: prog.url },
    title: text(p.title, 'title', 10, 150),
    asset: resolveAsset(prog, p.asset, req.assets, req.fields.asset?.required),
    weakness,
    severity,
    cvss_vector: p.cvss_vector ? text(p.cvss_vector, 'cvss_vector', 10, 200) : null,
    url,
    http_request: p.http_request ? text(p.http_request, 'http_request', 10, 30_000) : null,
    description: text(p.description, 'description', 80, 60_000),
    impact: text(p.impact, 'impact', 20, 10_000),
    custom_fields: custom,
    mode: {
      filing: direct ? 'direct' : 'platform_form',
      note: direct ? req.filing_note : custom.length && req.filing === 'direct'
        ? `${adapter.label} only accepts custom field values in its own form. The user finishes this draft there.`
        : req.filing_note,
    },
  };
}

// The asset must be one the program lists as in scope. `assets` carries the platform's own
// ids for them (structured scope id, target id).
export function resolveAsset(prog, input, assets = [], required = false) {
  const inScope = prog.scopes.filter((s) => s.inScope);
  const listed = (list) => list.slice(0, 15).map((s) => s.identifier).join(', ');
  if (!input) {
    if (required && inScope.length) throw new RunnerError('asset_required', `Name the affected asset. In scope: ${listed(inScope)}.`);
    return null;
  }
  if (!inScope.length) return { identifier: String(input).slice(0, 500), id: null };
  const want = String(input).trim().toLowerCase();
  let asset = inScope.find((s) => s.identifier.toLowerCase() === want);
  if (!asset) {
    const verdict = checkScope(prog.scopes, input);
    if (verdict.verdict === 'out_of_scope') throw new RunnerError('not_in_scope', `${input} is out of scope (${verdict.asset}). Do not report it.`);
    if (verdict.verdict !== 'in_scope') throw new RunnerError('not_in_scope', `${input} is not an in-scope asset. In scope: ${listed(inScope)}.`);
    asset = inScope.find((s) => s.identifier === verdict.asset);
  }
  const id = assets.find((a) => a.identifier === asset.identifier)?.id ?? asset.id ?? null;
  return { identifier: asset.identifier, id };
}

// Custom report fields a program defines. Values may be keyed by the field's key or label.
// Required fields must be present; list values must be one of the options.
export function customFields(defs, given = {}) {
  const values = given && typeof given === 'object' ? given : {};
  const lookup = (def) => {
    for (const [k, v] of Object.entries(values)) {
      if (k === def.key || k.trim().toLowerCase() === def.label.toLowerCase()) return v;
    }
    return undefined;
  };
  const out = [];
  const missing = [];
  for (const def of defs) {
    let v = lookup(def);
    if (v === undefined || v === null || v === '') {
      if (def.required) missing.push(def);
      continue;
    }
    if (def.type === 'checkbox') v = v === true || /^(true|yes|1|checked)$/i.test(String(v));
    else v = String(v).trim();
    if (def.type === 'list' && def.options) {
      const match = def.options.find((o) => o.toLowerCase() === String(v).toLowerCase());
      if (!match) throw new RunnerError('bad_field', `"${def.label}" must be one of: ${def.options.join(', ')}.`);
      v = match;
    }
    if (def.pattern && typeof v === 'string' && !new RegExp(def.pattern).test(v)) throw new RunnerError('bad_field', `"${def.label}" does not match the program's format.`);
    if (def.type === 'checkbox' && def.required && v !== true) missing.push(def);
    else out.push({ key: def.key, label: def.label, value: v });
  }
  if (missing.length) {
    const what = missing.map((d) => `"${d.label}"${d.options ? ` (one of: ${d.options.join(', ')})` : ''}${d.help ? `: ${d.help}` : ''}`);
    throw new RunnerError('missing_fields', `This program requires custom fields. Pass them in custom_fields: ${what.join('; ')}.`);
  }
  const unknown = Object.keys(values).filter((k) => !defs.some((d) => d.key === k || d.label.toLowerCase() === k.trim().toLowerCase()));
  if (unknown.length) throw new RunnerError('bad_field', `Unknown custom fields: ${unknown.join(', ')}. See get_report_requirements.`);
  return out;
}

function webUrl(value) {
  const s = String(value).trim();
  if (!/^https?:\/\/\S+$/i.test(s) || s.length > 2048) throw new RunnerError('bad_request', 'url must be an http(s) URL.');
  return s;
}

function text(value, name, min, max) {
  const s = String(value ?? '').trim();
  if (s.length < min || s.length > max) throw new RunnerError('bad_request', `${name} must be ${min} to ${max} characters.`);
  return s;
}

function step(draft, status, by) {
  const at = new Date().toISOString();
  return { ...draft, status, updated_at: at, history: [...draft.history, { at, event: status, by }] };
}

// What agents see of a draft.
export function publicDraft(d) {
  if (!d) return null;
  const label = getAdapter(d.platform)?.label || d.platform;
  const next = {
    pending_review: d.mode?.filing === 'direct'
      ? 'Waiting for the user. Call get_draft with wait_seconds to wait for the decision.'
      : `Waiting for the user, who finishes it in ${label}'s form. Call get_draft with wait_seconds to learn when it is filed.`,
    submitting: 'Being filed now.',
    submitted: 'Filed. Track it with list_my_reports.',
    rejected: 'The user rejected it. Read review_note; fix it with update_draft or drop it.',
    handed_off: `The user is finishing it in ${label}'s form.`,
    failed: 'Filing failed. Read error; fix it with update_draft, then the user can retry.',
  }[d.status];
  return {
    draft_id: d.id,
    status: d.status,
    platform: d.platform,
    program: d.handle,
    title: d.title,
    asset: d.asset?.identifier || null,
    weakness: d.weakness ? (d.weakness.priority ? `${d.weakness.name} (P${d.weakness.priority})` : d.weakness.name) : null,
    severity: d.severity,
    filing: d.mode?.filing,
    custom_fields: d.custom_fields?.length ? Object.fromEntries(d.custom_fields.map((c) => [c.label, c.value])) : undefined,
    created_at: d.created_at,
    updated_at: d.updated_at,
    review_note: d.review_note || undefined,
    attachments: (d.attachments || []).map((a) => ({ id: a.id, name: a.name, size: a.size, type: a.type })),
    report: d.report || undefined,
    error: d.error || undefined,
    form_prefill: d.prefill ? { filled: d.prefill.filled, missed: d.prefill.missed, error: d.prefill.error } : undefined,
    next,
  };
}

async function announce(draft) {
  await updateBadge();
  try {
    if (!(await ext.permissions.contains({ permissions: ['notifications'] }))) return;
    await ext.notifications.create(`draft:${draft.id}`, {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icons/icon-128.png'),
      title: 'Report draft to review',
      message: `${draft.program.name}: ${draft.title}`,
      priority: 1,
    });
  } catch { /* notifications are a convenience */ }
}

export async function updateBadge() {
  const n = Object.values(await getDrafts()).filter((d) => d.status === 'pending_review').length;
  await ext.action.setBadgeBackgroundColor?.({ color: '#20211f' });
  await ext.action.setBadgeText({ text: n ? String(n) : '' });
}
