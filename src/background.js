// Background: the agent bridge, the operation dispatcher, and the messages the popup and the
// console send. The popup's copy-as-Markdown flow does not need any of this.

import { build as buildMarkdown } from './render.js';
import { getAdapter } from './platforms/index.js';
import { connectBridge, disconnectBridge, setDispatcher } from './agent/bridge.js';
import { createOps } from './agent/ops.js';
import { submitDraft, handOff, rejectDraft, updateDraft, deleteDraft, updateBadge, resumeInterrupted, addAttachment, removeAttachment } from './agent/drafts.js';
import { loadFile, saveFile, checkName, typeFor, sha256, toBase64, fromBase64, MAX_FILE_BYTES } from './agent/files.js';
import { getSettings, setSettings, getDrafts, getActivity, getConnection, clearActivity, FINISHED } from './agent/store.js';
import { sweep, sweepStatus, listEvents, resetWatch } from './agent/watch.js';

const ext = globalThis.browser ?? globalThis.chrome;

// Some program briefs are HTML. Firefox's background page has a DOM; Chrome's service worker
// does not, so there the conversion runs in an offscreen document.
async function build(program) {
  if (typeof DOMParser !== 'undefined') {
    const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
    return buildMarkdown(program, { parse });
  }
  if (!(await ext.offscreen.hasDocument?.())) {
    try {
      await ext.offscreen.createDocument({ url: 'src/offscreen.html', reasons: ['DOM_PARSER'], justification: 'Convert program brief HTML to Markdown.' });
    } catch (e) {
      if (!/single offscreen/i.test(String(e?.message))) throw e;
    }
  }
  const out = await ext.runtime.sendMessage({ target: 'offscreen', type: 'build', program });
  if (out?.error) throw new Error(out.error);
  return out;
}

setDispatcher(createOps({ build }));

// Scope watch on a timer, when the user turned it on. Every half hour it checks the platforms and
// tells the user about new in-scope assets.
const WATCH_ALARM = 'scope-watch';
const WATCH_MINUTES = 30;

async function scheduleWatch() {
  if (!ext.alarms) return;
  const s = await getSettings();
  if (!s.scopeWatch || !s.agentEnabled) {
    await ext.alarms.clear(WATCH_ALARM);
    return;
  }
  if (!(await ext.alarms.get(WATCH_ALARM))) ext.alarms.create(WATCH_ALARM, { delayInMinutes: 1, periodInMinutes: WATCH_MINUTES });
}

async function watchTick() {
  const s = await getSettings();
  if (!s.scopeWatch || !s.agentEnabled) return;
  const started = new Date().toISOString();
  await sweep({ force: true }).catch(() => {});
  // What the platforms changed recently, not the first check's look back over past weeks.
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const fresh = (await listEvents({ in_scope_only: true, kinds: ['added', 'program_added'] }))
    .filter((e) => e.seen_at >= started && (e.dated_by === 'scopedown' || e.at >= recent) && s.platforms[e.platform] !== false);
  if (!fresh.length) return;
  try {
    if (!(await ext.permissions.contains({ permissions: ['notifications'] }))) return;
    const programs = new Map();
    for (const e of fresh) programs.set(e.program_name, (programs.get(e.program_name) || 0) + 1);
    const assets = fresh.filter((e) => e.kind === 'added').length;
    const invites = fresh.filter((e) => e.kind === 'program_added').length;
    await ext.notifications.create('scope:new', {
      type: 'basic',
      iconUrl: ext.runtime.getURL('icons/icon-128.png'),
      title: [assets ? `${assets} new in-scope asset${assets === 1 ? '' : 's'}` : null, invites ? `${invites} new program${invites === 1 ? '' : 's'}` : null].filter(Boolean).join(', '),
      message: [...programs].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => `${name} (${n})`).join(', '),
      priority: 1,
    });
  } catch { /* notifications are a convenience */ }
}

ext.alarms?.onAlarm.addListener((a) => {
  if (a.name === WATCH_ALARM) watchTick();
});

// What the console's Scope page shows: every change that matches the filters except the kind,
// which the page splits into its tabs.
const SCOPE_ROWS = 5000;

// Requests from ScopeDown's own pages. Agents never reach these: they arrive only through
// the native bridge and the operation table.
const handlers = {
  async 'agent:get'() {
    const drafts = Object.values(await getDrafts());
    const last = (await getActivity()).find((e) => e.client && e.client !== 'agent');
    return {
      settings: await getSettings(),
      connection: await getConnection(),
      waiting: drafts.filter((d) => d.status === 'pending_review').length,
      lastClient: last ? { client: last.client, at: last.at } : null,
    };
  },
  async 'activity:clear'() {
    await clearActivity();
  },
  async 'drafts:clear-finished'() {
    const done = Object.values(await getDrafts()).filter((d) => FINISHED.includes(d.status));
    for (const d of done) await deleteDraft(d.id);
    return done.length;
  },
  async 'agent:enable'({ enabled }) {
    await setSettings({ agentEnabled: Boolean(enabled) });
    if (enabled) await connectBridge();
    else await disconnectBridge();
    await scheduleWatch();
    return handlers['agent:get']();
  },
  async 'scope:list'({ filters = {} }) {
    const s = await getSettings();
    const events = (await listEvents(filters)).filter((e) => s.platforms[e.platform] !== false);
    return { status: await sweepStatus(), watch: Boolean(s.scopeWatch), every: WATCH_MINUTES, total: events.length, events: events.slice(0, SCOPE_ROWS) };
  },
  'scope:status': () => sweepStatus(),
  async 'scope:check'() {
    sweep({ force: true }).catch(() => {});
    return sweepStatus();
  },
  async 'scope:auto'({ enabled }) {
    await setSettings({ scopeWatch: Boolean(enabled) });
    await scheduleWatch();
    return Boolean(enabled);
  },
  async 'scope:reset'() {
    await resetWatch();
  },
  async 'agent:platform'({ platform, enabled }) {
    if (!getAdapter(platform)) throw new Error(`Unknown platform ${platform}.`);
    const s = await getSettings();
    return setSettings({ platforms: { ...s.platforms, [platform]: Boolean(enabled) } });
  },
  async 'agent:autosubmit'({ key, enabled }) {
    const [platform, handle] = String(key).split(':');
    if (!getAdapter(platform)?.agent.file || !/^[\w.-]{1,120}$/.test(handle || '')) {
      throw new Error('Auto-submit needs a program on a platform ScopeDown can file to directly.');
    }
    const s = await getSettings();
    const list = new Set(s.autoSubmit);
    if (enabled) list.add(key);
    else list.delete(key);
    return setSettings({ autoSubmit: [...list] });
  },
  async 'drafts:list'() {
    return Object.values(await getDrafts()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  'activity:list': () => getActivity(),
  'draft:save': ({ id, fields }) => updateDraft(id, fields, 'user'),
  'draft:submit': ({ id, reviewed }) => submitDraft(id, { by: 'user', reviewed }),
  'draft:handoff': ({ id }) => handOff(id, { by: 'user' }),
  'draft:reject': ({ id, note }) => rejectDraft(id, note, { by: 'user' }),
  'draft:delete': ({ id }) => deleteDraft(id),
  async 'file:get'({ fileId }) {
    const f = await loadFile(fileId);
    if (!f) throw new Error('File not found.');
    return { name: f.name, type: f.type, size: f.size, base64: toBase64(f.bytes) };
  },
  'file:remove': ({ id, fileId }) => removeAttachment(id, fileId, 'user'),
  async 'file:add'({ id, name, base64 }) {
    const clean = checkName(name);
    const bytes = fromBase64(base64);
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error(`Files must be 1 byte to ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const meta = { id: `f_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, name: clean, type: typeFor(clean), size: bytes.length, sha256: await sha256(bytes), added_by: 'user', added_at: new Date().toISOString() };
    await saveFile({ ...meta, draftId: id, bytes });
    return addAttachment(id, meta);
  },
};

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  // Only ScopeDown's own extension pages may call these, never a content script or a website.
  if (sender.id !== ext.runtime.id || !sender.url?.startsWith(ext.runtime.getURL(''))) return false;
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg))
    .then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

// chrome.notifications exists only once the optional permission is granted.
async function openDraftFromNotification(id) {
  if (id === 'scope:new') await ext.tabs.create({ url: ext.runtime.getURL('src/console.html#/scope') });
  else if (id.startsWith('draft:')) await ext.tabs.create({ url: ext.runtime.getURL(`src/console.html#/drafts/${id.slice(6)}`) });
  else return;
  ext.notifications.clear(id);
}
function listenNotifications() {
  if (ext.notifications && !ext.notifications.onClicked.hasListener(openDraftFromNotification)) {
    ext.notifications.onClicked.addListener(openDraftFromNotification);
  }
}
listenNotifications();

ext.permissions.onAdded.addListener(() => {
  listenNotifications();
  connectBridge();
});
ext.runtime.onStartup.addListener(() => connectBridge());
ext.runtime.onInstalled.addListener(() => connectBridge());
connectBridge();
scheduleWatch();
updateBadge();
resumeInterrupted();
