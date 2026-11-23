// Native messaging host. The browser starts this process when the extension connects.
// It relays requests from local MCP servers (over a Unix socket only this user can open)
// to the extension, and the extension's answers back. It makes no decisions of its own:
// the extension validates every operation.

import { createServer } from 'node:net';
import { mkdirSync, chmodSync, unlinkSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { encodeNative, nativeDecoder, encodeLine, lineDecoder } from './framing.js';
import { scopedownHome, socketsDir, socketPath, logFile } from './paths.js';

// The sockets folder holds the Unix sockets, and on every OS the marker files that tell the
// MCP server where each host listens (on Windows the markers are the only way to find a pipe).
export function prepareDirs(os = platform()) {
  mkdirSync(scopedownHome(), { recursive: true, mode: 0o700 });
  mkdirSync(socketsDir(), { recursive: true, mode: 0o700 });
  if (os !== 'win32') chmodSync(socketsDir(), 0o700);
}

export function runHost({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const log = (msg) => {
    try {
      appendFileSync(logFile(), `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
    } catch { /* logging is best effort */ }
  };

  prepareDirs();

  const name = `host-${process.pid}`;
  const path = socketPath(name);
  const clients = new Map(); // client id -> socket
  const pending = new Map(); // relay id -> { client, id }
  let hello = null;
  let relaySeq = 0;
  let clientSeq = 0;

  const toBrowser = (message) => stdout.write(encodeNative(message));

  // Messages from the extension.
  stdin.on('data', nativeDecoder((msg) => {
    if (msg?.type === 'hello') {
      hello = { ...msg.extension, connectedAt: new Date().toISOString() };
      log(`extension connected: ${JSON.stringify(hello)}`);
      // A marker file lets `scopedown-mcp doctor` show which browser owns which socket.
      try {
        writeFileSync(join(socketsDir(), `${name}.json`), JSON.stringify({ pid: process.pid, socket: path, extension: hello }));
      } catch { /* optional */ }
      toBrowser({ type: 'hello_ack', socket: path, pid: process.pid });
      return;
    }
    if (msg?.type === 'response' && pending.has(msg.id)) {
      const { client, id } = pending.get(msg.id);
      pending.delete(msg.id);
      clients.get(client)?.write(encodeLine({ ...msg, id }));
    }
  }, (e) => log(`bad message from browser: ${e.message}`)));

  const server = createServer((socket) => {
    const client = ++clientSeq;
    clients.set(client, socket);
    socket.on('data', lineDecoder((msg) => {
      if (msg?.type === 'status') {
        socket.write(encodeLine({ type: 'status', id: msg.id, host: { pid: process.pid, socket: path }, extension: hello }));
        return;
      }
      if (msg?.type !== 'request' || typeof msg.id !== 'string' || typeof msg.op !== 'string') {
        socket.write(encodeLine({ type: 'response', id: msg?.id, ok: false, error: { code: 'bad_request', message: 'Expected a request with an id and an op.' } }));
        return;
      }
      if (!hello) {
        socket.write(encodeLine({ type: 'response', id: msg.id, ok: false, error: { code: 'not_connected', message: 'The ScopeDown extension has not said hello yet.' } }));
        return;
      }
      const relayId = `${client}:${++relaySeq}`;
      pending.set(relayId, { client, id: msg.id });
      try {
        toBrowser({ type: 'request', id: relayId, op: msg.op, params: msg.params ?? {}, client: msg.client ?? null });
      } catch (e) {
        pending.delete(relayId);
        socket.write(encodeLine({ type: 'response', id: msg.id, ok: false, error: { code: 'too_large', message: e.message } }));
      }
    }, () => socket.destroy()));
    const drop = () => {
      clients.delete(client);
      for (const [relayId, p] of pending) if (p.client === client) pending.delete(relayId);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  const cleanup = () => {
    server.close();
    if (platform() !== 'win32') {
      for (const f of [path, join(socketsDir(), `${name}.json`)]) {
        try { unlinkSync(f); } catch { /* already gone */ }
      }
    }
  };

  server.listen(path, () => {
    if (platform() !== 'win32') chmodSync(path, 0o600);
    log(`listening on ${path}`);
  });
  server.on('error', (e) => {
    log(`socket error: ${e.message}`);
    process.exit(1);
  });

  // The browser closes stdin when the extension disconnects or the browser quits.
  stdin.on('end', () => {
    log('browser disconnected');
    cleanup();
    process.exit(0);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { cleanup(); process.exit(0); });

  // Remove sockets left behind by hosts that crashed.
  pruneStale(path);
  return { server, path };
}

function pruneStale(own) {
  if (platform() === 'win32') return;
  for (const f of readdirSync(socketsDir())) {
    const m = f.match(/^host-(\d+)\.(sock|json)$/);
    if (!m || join(socketsDir(), f) === own || Number(m[1]) === process.pid) continue;
    try {
      process.kill(Number(m[1]), 0);
    } catch {
      try { unlinkSync(join(socketsDir(), f)); } catch { /* raced */ }
    }
  }
}
