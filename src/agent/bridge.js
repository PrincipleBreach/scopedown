// Keeps the native messaging connection to the local bridge while agent access is on.

import { getSettings, installId, setConnection } from './store.js';

const ext = globalThis.browser ?? globalThis.chrome;
export const HOST = 'com.principlebreach.scopedown';

let port = null;
let retryTimer = null;
let backoff = 2000;
let dispatch = null;

export function setDispatcher(fn) {
  dispatch = fn;
}

let opening = null;

// Safe to call from several events at once: only one connection attempt runs at a time.
export function connectBridge() {
  opening ??= open().finally(() => { opening = null; });
  return opening;
}

async function open() {
  clearTimeout(retryTimer);
  const s = await getSettings();
  if (!s.agentEnabled) return setConnection({ state: 'off' });
  if (port) return;
  if (!(await ext.permissions.contains({ permissions: ['nativeMessaging'] }))) {
    return setConnection({ state: 'needs_permission' });
  }
  const install = await installId();

  let p;
  try {
    p = ext.runtime.connectNative(HOST);
  } catch (e) {
    await setConnection({ state: 'host_missing', error: String(e?.message || e) });
    return retryLater();
  }
  port = p;

  // Listeners go on before any await, so a host that fails at once is never missed.
  let acked = false;
  const watchdog = setTimeout(() => {
    if (acked || port !== p) return;
    try { p.disconnect(); } catch { /* already closed */ }
    gone(p, 'The bridge started but did not answer. Run "npx @principlebreach/scopedown-mcp doctor".');
  }, 10_000);

  p.onMessage.addListener(async (msg) => {
    if (msg?.type === 'hello_ack') {
      acked = true;
      clearTimeout(watchdog);
      backoff = 2000;
      await setConnection({ state: 'connected', socket: msg.socket || null });
      return;
    }
    if (msg?.type !== 'request' || !dispatch) return;
    const reply = await dispatch(msg.op, msg.params, msg.client);
    try {
      p.postMessage({ type: 'response', id: msg.id, ...reply });
    } catch { /* disconnected meanwhile */ }
  });
  p.onDisconnect.addListener(() => {
    clearTimeout(watchdog);
    gone(p, ext.runtime.lastError?.message || p.error?.message || '');
  });

  p.postMessage({ type: 'hello', extension: { version: ext.runtime.getManifest().version, browser: browserName(), install } });
  if (port === p && !acked) await setConnection({ state: 'connecting' });
}

async function gone(p, error) {
  if (port !== p) return;
  port = null;
  const missing = /not found|no such native application|host not found|forbidden/i.test(error);
  await setConnection({ state: missing ? 'host_missing' : 'disconnected', error: error || null });
  retryLater();
}

export async function disconnectBridge() {
  clearTimeout(retryTimer);
  const p = port;
  port = null;
  try { p?.disconnect(); } catch { /* already closed */ }
  await setConnection({ state: 'off' });
}

async function retryLater() {
  const s = await getSettings();
  if (!s.agentEnabled) return;
  retryTimer = setTimeout(connectBridge, backoff);
  backoff = Math.min(backoff * 2, 60_000);
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (navigator.brave || brands.includes('Brave')) return 'Brave';
  for (const name of ['Microsoft Edge', 'Opera', 'Vivaldi', 'Arc', 'Google Chrome', 'Chromium']) {
    if (brands.includes(name)) return name.replace('Google ', '').replace('Microsoft ', '');
  }
  return /Firefox\//.test(navigator.userAgent) ? 'Firefox' : 'Chromium';
}
