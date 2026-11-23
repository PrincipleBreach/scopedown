// Persistent state for the agent bridge: settings, drafts and the activity log, all in
// browser.storage.local so they survive service worker restarts.

const ext = globalThis.browser ?? globalThis.chrome;

export const DEFAULT_SETTINGS = {
  agentEnabled: false,
  // Per-platform switches by adapter id; a platform not listed here is allowed.
  platforms: {},
  // Keys like "hackerone:my_sandbox". Drafts for these programs are filed without review.
  autoSubmit: [],
};

export async function getSettings() {
  const { settings } = await ext.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings, platforms: { ...DEFAULT_SETTINGS.platforms, ...settings?.platforms } };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await ext.storage.local.set({ settings: next });
  return next;
}

export async function installId() {
  const { install } = await ext.storage.local.get('install');
  if (install) return install;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  await ext.storage.local.set({ install: id });
  return id;
}

const LOG_LIMIT = 300;

export async function logActivity(entry) {
  const { activity = [] } = await ext.storage.local.get('activity');
  activity.unshift({ at: new Date().toISOString(), ...entry });
  await ext.storage.local.set({ activity: activity.slice(0, LOG_LIMIT) });
}

export async function getActivity() {
  const { activity = [] } = await ext.storage.local.get('activity');
  return activity;
}

export async function getDrafts() {
  const { drafts = {} } = await ext.storage.local.get('drafts');
  return drafts;
}

export async function putDraft(draft) {
  const drafts = await getDrafts();
  drafts[draft.id] = draft;
  // Keep the newest 200; finished ones go first.
  const ids = Object.values(drafts).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((d) => d.id);
  for (const id of ids.slice(200)) delete drafts[id];
  await ext.storage.local.set({ drafts });
  return draft;
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
