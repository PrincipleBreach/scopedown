// Persistent state for the agent bridge: settings, drafts and the activity log, all in
// browser.storage.local so they survive service worker restarts.

import { deleteFile } from './files.js';

const ext = globalThis.browser ?? globalThis.chrome;

// Every read-modify-write of stored state goes through this queue. Agents call in parallel, and
// two writers that each read, change and write back the whole map would drop each other's change.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Drafts nobody is waiting on any more. The cap below drops only these.
export const FINISHED = ['submitted', 'rejected', 'handed_off'];
const DRAFT_LIMIT = 200;

export const DEFAULT_SETTINGS = {
  agentEnabled: false,
  // Per-platform switches by adapter id; a platform not listed here is allowed.
  platforms: {},
  // Keys like "hackerone:my_sandbox". Drafts for these programs are filed without review.
  autoSubmit: [],
  // Check every program's scope on a timer and notify about new in-scope assets.
  scopeWatch: false,
};

export async function getSettings() {
  const { settings } = await ext.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings, platforms: { ...DEFAULT_SETTINGS.platforms, ...settings?.platforms } };
}

export function setSettings(patch) {
  return serial(async () => {
    const next = { ...(await getSettings()), ...patch };
    await ext.storage.local.set({ settings: next });
    return next;
  });
}

export async function installId() {
  const { install } = await ext.storage.local.get('install');
  if (install) return install;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  await ext.storage.local.set({ install: id });
  return id;
}

const LOG_LIMIT = 300;

export function logActivity(entry) {
  return serial(async () => {
    const { activity = [] } = await ext.storage.local.get('activity');
    activity.unshift({ at: new Date().toISOString(), ...entry });
    await ext.storage.local.set({ activity: activity.slice(0, LOG_LIMIT) });
  });
}

export function clearActivity() {
  return serial(() => ext.storage.local.set({ activity: [] }));
}

export async function getActivity() {
  const { activity = [] } = await ext.storage.local.get('activity');
  return activity;
}

export async function getDrafts() {
  const { drafts = {} } = await ext.storage.local.get('drafts');
  return drafts;
}

export function putDraft(draft) {
  return serial(async () => {
    const drafts = await getDrafts();
    drafts[draft.id] = draft;
    // Past the limit the oldest finished drafts go, with their evidence files. A draft that
    // still waits on the hunter or the platform is never dropped.
    const over = Object.keys(drafts).length - DRAFT_LIMIT;
    const gone = over > 0
      ? Object.values(drafts).filter((d) => FINISHED.includes(d.status)).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, over)
      : [];
    for (const d of gone) delete drafts[d.id];
    await ext.storage.local.set({ drafts });
    for (const a of gone.flatMap((d) => d.attachments || [])) await deleteFile(a.id).catch(() => {});
    return draft;
  });
}

// Removes a draft and returns it, so the caller can delete its files.
export function removeDraft(id) {
  return serial(async () => {
    const drafts = await getDrafts();
    const gone = drafts[id] || null;
    delete drafts[id];
    await ext.storage.local.set({ drafts });
    return gone;
  });
}

export async function getDraft(id) {
  return (await getDrafts())[id] || null;
}

export async function getConnection() {
  const { connection } = await ext.storage.session?.get('connection') ?? await ext.storage.local.get('connection');
  return connection || { state: 'off' };
}

export async function setConnection(connection) {
  const value = { ...connection, at: new Date().toISOString() };
  if (ext.storage.session) await ext.storage.session.set({ connection: value });
  else await ext.storage.local.set({ connection: value });
}
