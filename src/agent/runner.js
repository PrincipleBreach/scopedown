// Runs page functions inside a platform tab, with a per-platform rate limit and a small cache.
// Prefers a tab the user already has open on the platform. Otherwise it opens a quiet
// background tab and closes it after a few idle minutes.

const ext = globalThis.browser ?? globalThis.chrome;

const WORKER_PATH = '/robots.txt';
const MIN_GAP_MS = 340; // about 3 requests per second per platform
const IDLE_CLOSE_MS = 3 * 60_000;

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const lastRun = {};
const queues = {};
const workers = {}; // origin -> tab id we opened
let idleTimer = null;

// Serializes calls per platform and spaces them out.
function schedule(platform, fn) {
  const prev = queues[platform] || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const wait = (lastRun[platform] || 0) + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRun[platform] = Date.now();
    return fn();
  });
  queues[platform] = next;
  return next;
}

async function candidateTabs(origin) {
  const tabs = await ext.tabs.query({ url: `${origin}/*` });
  const worker = workers[origin];
  return tabs
    .filter((t) => t.status === 'complete' && !t.discarded)
    .sort((a, b) => (b.id === worker) - (a.id === worker) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

async function openWorker(origin) {
  const tab = await ext.tabs.create({ url: origin + WORKER_PATH, active: false });
  workers[origin] = tab.id;
  await new Promise((resolve) => {
    const done = () => {
      ext.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => { if (id === tab.id && info.status === 'complete') done(); };
    const timer = setTimeout(done, 15_000);
    ext.tabs.onUpdated.addListener(listener);
  });
  return tab.id;
}

function touchWorkers() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    for (const [origin, id] of Object.entries(workers)) {
      delete workers[origin];
      try { await ext.tabs.remove(id); } catch { /* user closed it */ }
    }
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.(); // Node (tests) only; browsers return a number.
}

async function inject(tabId, func, args) {
  const [res] = await ext.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  return res?.result;
}

// Runs func(...args) in a working tab on `origin` (for example https://hackerone.com) and
// returns its result. Calls to one origin are queued and spaced out.
export async function runInPlatform(origin, func, args = []) {
  if (!/^https:\/\/[\w.-]+$/.test(origin)) throw new RunnerError('bad_platform', `Not a platform origin: ${origin}.`);
  const granted = await ext.permissions.contains({ origins: [`${origin}/*`] });
  if (!granted) throw new RunnerError('no_permission', `ScopeDown does not have access to ${origin}. Turn Agent access off and on again in the popup to grant it.`);

  return schedule(origin, async () => {
    touchWorkers();
    for (const tab of await candidateTabs(origin)) {
      try {
        const out = await inject(tab.id, func, args);
        if (out?.error?.code === 'bad_tab') continue;
        return out;
      } catch {
        // Tab navigated away or blocks injection; try the next.
      }
    }
    const id = await openWorker(origin);
    const out = await inject(id, func, args);
    if (out?.error?.code === 'bad_tab') throw new RunnerError('platform', out.error.message);
    return out;
  });
}

const cache = new Map();

export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

export function forget(prefix) {
  for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}
