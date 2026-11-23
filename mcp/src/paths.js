import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const HOST_NAME = 'com.principlebreach.scopedown';

// Extension IDs the native host accepts. Chromium: the unpacked dev build (its ID comes
// from the "key" in manifest.json), then the Chrome Web Store build.
export const CHROMIUM_EXTENSION_IDS = ['gpmmeoibimhbhpcfjnhedolifmgieemi', 'cmckgjmbejafmpngecmdbjilcjnhcagl'];
export const FIREFOX_EXTENSION_IDS = ['scopedown@principlebreach.com'];

// SCOPEDOWN_HOME lets tests run against a throwaway directory.
export function scopedownHome() {
  return process.env.SCOPEDOWN_HOME || join(homedir(), '.scopedown');
}

export function socketsDir() {
  return join(scopedownHome(), 'sockets');
}

export function socketPath(name) {
  if (platform() === 'win32') return `\\\\.\\pipe\\scopedown-${name}`;
  return join(socketsDir(), `${name}.sock`);
}

export function binDir() {
  return join(scopedownHome(), 'bin');
}

export function logFile() {
  return join(scopedownHome(), 'host.log');
}
