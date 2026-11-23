// Registers the native messaging host with each installed browser, so the browser can
// start it when the ScopeDown extension connects.

import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readdirSync, readFileSync, cpSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST_NAME, CHROMIUM_EXTENSION_IDS, FIREFOX_EXTENSION_IDS, binDir, scopedownHome, socketsDir } from './paths.js';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');

// The host needs only Node built-ins, so its code is copied out of the package (an npx cache
// or a checkout that may move) into ~/.scopedown/app.
function copyApp() {
  const app = join(scopedownHome(), 'app');
  rmSync(app, { recursive: true, force: true });
  for (const dir of ['bin', 'src']) cpSync(join(PACKAGE, dir), join(app, dir), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  return join(app, 'bin', 'scopedown-mcp.js');
}

// Prefer the `node` on PATH when it is the same binary, since versioned paths such as
// Homebrew's Cellar disappear on upgrade.
function nodePath() {
  const self = realpathSync(process.execPath);
  for (const dir of String(process.env.PATH || '').split(platform() === 'win32' ? ';' : ':')) {
    const candidate = join(dir, platform() === 'win32' ? 'node.exe' : 'node');
    try {
      if (dir && realpathSync(candidate) === self) return candidate;
    } catch { /* not here */ }
  }
  return process.execPath;
}

// Per-user NativeMessagingHosts folders. Only browsers whose profile folder exists get a manifest.
function targets(given) {
  const home = given || homedir();
  const os = platform();
  if (os === 'darwin') {
    const lib = join(home, 'Library', 'Application Support');
    return [
      ['Chrome', join(lib, 'Google', 'Chrome'), 'chromium'],
      ['Chrome Beta', join(lib, 'Google', 'Chrome Beta'), 'chromium'],
      ['Chromium', join(lib, 'Chromium'), 'chromium'],
      ['Brave', join(lib, 'BraveSoftware', 'Brave-Browser'), 'chromium'],
      ['Edge', join(lib, 'Microsoft Edge'), 'chromium'],
      ['Arc', join(lib, 'Arc', 'User Data'), 'chromium'],
      ['Vivaldi', join(lib, 'Vivaldi'), 'chromium'],
      ['Firefox', join(lib, 'Mozilla'), 'firefox'],
    ].map(([name, root, kind]) => ({ name, root, kind, dir: join(root, kind === 'firefox' ? 'NativeMessagingHosts' : 'NativeMessagingHosts') }));
  }
  if (os === 'linux') {
    // XDG_CONFIG_HOME belongs to the real home, so a home passed in (tests) keeps its own .config.
    const cfg = (!given && process.env.XDG_CONFIG_HOME) || join(home, '.config');
    return [
      ['Chrome', join(cfg, 'google-chrome'), 'chromium'],
      ['Chromium', join(cfg, 'chromium'), 'chromium'],
      ['Brave', join(cfg, 'BraveSoftware', 'Brave-Browser'), 'chromium'],
      ['Edge', join(cfg, 'microsoft-edge'), 'chromium'],
      ['Vivaldi', join(cfg, 'vivaldi'), 'chromium'],
      ['Firefox', join(home, '.mozilla'), 'firefox'],
    ].map(([name, root, kind]) => ({ name, root, kind, dir: join(root, kind === 'firefox' ? 'native-messaging-hosts' : 'NativeMessagingHosts') }));
  }
  if (os === 'win32') {
    // Windows reads the manifest path from the registry; the file itself can live anywhere.
    return [
      ['Chrome', 'HKCU\\Software\\Google\\Chrome', 'chromium'],
      ['Brave', 'HKCU\\Software\\BraveSoftware\\Brave-Browser', 'chromium'],
      ['Edge', 'HKCU\\Software\\Microsoft\\Edge', 'chromium'],
      ['Firefox', 'HKCU\\Software\\Mozilla', 'firefox'],
    ].map(([name, root, kind]) => ({ name, root, kind, dir: join(scopedownHome(), 'manifests', name.toLowerCase()), registry: `${root}\\NativeMessagingHosts\\${HOST_NAME}` }));
  }
  return [];
}

// The browser starts the host with a bare environment, so the launcher pins the absolute
// path of the Node binary that ran the installer.
function writeLauncher() {
  mkdirSync(binDir(), { recursive: true, mode: 0o700 });
  const cli = copyApp();
  const node = nodePath();
  if (platform() === 'win32') {
    const path = join(binDir(), 'scopedown-host.bat');
    writeFileSync(path, `@echo off\r\n"${node}" "${cli}" host %*\r\n`);
    return path;
  }
  const path = join(binDir(), 'scopedown-host');
  // A custom SCOPEDOWN_HOME (tests, portable setups) is pinned too, since browsers drop the environment.
  const env = process.env.SCOPEDOWN_HOME ? `SCOPEDOWN_HOME="${process.env.SCOPEDOWN_HOME}" ` : '';
  writeFileSync(path, `#!/bin/sh\n${env}exec "${node}" "${cli}" host "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

export function manifestFor(kind, launcher, { extensionIds = [] } = {}) {
  const base = { name: HOST_NAME, description: 'ScopeDown agent bridge by Principle Breach', path: launcher, type: 'stdio' };
  if (kind === 'firefox') return { ...base, allowed_extensions: [...FIREFOX_EXTENSION_IDS] };
  const ids = [...new Set([...CHROMIUM_EXTENSION_IDS, ...extensionIds])];
  return { ...base, allowed_origins: ids.map((id) => `chrome-extension://${id}/`) };
}

// Brave reads native messaging manifests from Google Chrome's folder (checked on Brave 1.99,
// Chromium 157, macOS), so a Brave install also registers there.
const SHARES_CHROME_FOLDER = ['Brave'];

export function install({ extensionIds = [], only = null, home } = {}) {
  const launcher = writeLauncher();
  const done = [];
  const all = targets(home);
  const chrome = all.find((t) => t.name === 'Chrome');
  const wanted = all.filter((t) => (!only || only.includes(t.name.toLowerCase())) && (t.registry || existsSync(t.root)));
  if (chrome && !wanted.includes(chrome) && wanted.some((t) => SHARES_CHROME_FOLDER.includes(t.name))) {
    wanted.push({ ...chrome, name: 'Chrome (read by Brave)' });
  }
  for (const t of wanted) {
    mkdirSync(t.dir, { recursive: true });
    const file = join(t.dir, `${HOST_NAME}.json`);
    writeFileSync(file, `${JSON.stringify(manifestFor(t.kind, launcher, { extensionIds }), null, 2)}\n`);
    if (t.registry) execFileSync('reg', ['add', t.registry, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'ignore' });
    done.push({ browser: t.name, manifest: file });
  }
  return { launcher, installed: done };
}

export function uninstall({ home } = {}) {
  const removed = [];
  for (const t of targets(home)) {
    const file = join(t.dir, `${HOST_NAME}.json`);
    if (existsSync(file)) {
      rmSync(file);
      removed.push({ browser: t.name, manifest: file });
    }
    if (t.registry) {
      try { execFileSync('reg', ['delete', t.registry, '/f'], { stdio: 'ignore' }); } catch { /* not registered */ }
    }
  }
  rmSync(binDir(), { recursive: true, force: true });
  rmSync(join(scopedownHome(), 'app'), { recursive: true, force: true });
  return { removed };
}

export function doctor({ home } = {}) {
  const manifests = targets(home)
    .filter((t) => t.registry || existsSync(t.root))
    .map((t) => {
      const file = join(t.dir, `${HOST_NAME}.json`);
      let launcherOk = false;
      if (existsSync(file)) {
        try { launcherOk = existsSync(JSON.parse(readFileSync(file, 'utf8')).path); } catch { /* unreadable */ }
      }
      return { browser: t.name, installed: existsSync(file), launcherOk };
    });
  let hosts = [];
  try {
    hosts = readdirSync(socketsDir()).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(socketsDir(), f), 'utf8')));
  } catch { /* none running */ }
  return { node: process.execPath, home: scopedownHome(), manifests, hosts };
}
