// Connects the MCP server to every running native host (one per connected browser)
// and sends requests to the right one.

import { connect } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeLine, lineDecoder } from './framing.js';
import { socketsDir } from './paths.js';

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Bridge {
  constructor({ clientInfo = null } = {}) {
    this.clientInfo = clientInfo;
    this.links = new Map(); // socket path -> { socket, pending, extension }
  }

  // Socket paths of hosts that are running now.
  discover() {
    if (platform() === 'win32') {
      // Named pipes cannot be listed portably; hosts publish their pipe in a marker file.
      return this.markers().map((m) => m.socket);
    }
    try {
      return readdirSync(socketsDir()).filter((f) => f.endsWith('.sock')).map((f) => join(socketsDir(), f));
    } catch {
      return [];
    }
  }

  markers() {
    try {
      return readdirSync(socketsDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(socketsDir(), f), 'utf8')));
    } catch {
      return [];
    }
  }

  async open(path) {
    if (this.links.has(path)) return this.links.get(path);
    const link = await new Promise((resolve, reject) => {
      const socket = connect(path);
      const pending = new Map();
      const entry = { path, socket, pending, extension: null };
      socket.on('data', lineDecoder((msg) => {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }));
      const fail = () => {
        this.links.delete(path);
        for (const w of pending.values()) {
          clearTimeout(w.timer);
          w.reject(new BridgeError('disconnected', 'The browser disconnected while the request was running.'));
        }
        pending.clear();
      };
      socket.on('close', fail);
      socket.once('error', (e) => {
        fail();
        reject(e);
      });
      socket.once('connect', () => resolve(entry));
    });
    this.links.set(path, link);
    const status = await this.send(link, { type: 'status' }, 5000);
    link.extension = status.extension;
    return link;
  }

  send(link, message, timeoutMs) {
    const id = message.id ?? randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new BridgeError('timeout', `The browser did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      link.pending.set(id, { resolve, reject, timer });
      link.socket.write(encodeLine({ ...message, id }));
    });
  }

  // Every browser that has the extension connected right now.
  async browsers() {
    const found = [];
    for (const path of this.discover()) {
      try {
        const link = await this.open(path);
        if (link.extension) found.push(link);
      } catch {
        // A stale socket from a host that died; the next host start prunes it.
      }
    }
    return found;
  }

  async pick(browser) {
    const all = await this.browsers();
    if (!all.length) {
      throw new BridgeError('no_browser', 'No browser is connected. Open the browser where you use HackerOne or Bugcrowd, click the ScopeDown icon, and switch Agents on.');
    }
    // Socket names follow the host's process id, which changes when a browser restarts. The
    // install id does not, so the default browser (and the drafts it holds) stays the same.
    if (!browser) return all.reduce((a, b) => (String(b.extension.install) < String(a.extension.install) ? b : a));
    const want = browser.toLowerCase();
    const match = all.find((l) => [l.extension.install, l.extension.browser].some((v) => String(v || '').toLowerCase() === want));
    if (!match) throw new BridgeError('unknown_browser', `No connected browser called "${browser}". Connected: ${all.map(label).join(', ')}.`);
    return match;
  }

  async request(op, params = {}, { browser, timeoutMs = 60_000 } = {}) {
    const link = await this.pick(browser);
    const reply = await this.send(link, { type: 'request', op, params, client: this.clientInfo }, timeoutMs);
    if (!reply.ok) throw new BridgeError(reply.error?.code || 'error', reply.error?.message || 'The extension refused the request.');
    return { result: reply.result, browser: label(link) };
  }

  close() {
    for (const l of this.links.values()) l.socket.destroy();
    this.links.clear();
  }
}

export function label(link) {
  const e = link.extension || {};
  return e.browser ? `${e.browser} (${String(e.install || '').slice(0, 6)})` : link.path;
}
