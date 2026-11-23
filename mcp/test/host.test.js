// The native host's own folders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the sockets folder exists on Windows too, where the markers are how hosts are found', async () => {
  process.env.SCOPEDOWN_HOME = join(mkdtempSync(join(tmpdir(), 'scopedown-host-')), '.scopedown');
  const { prepareDirs } = await import('../src/host.js');
  const { socketsDir } = await import('../src/paths.js');
  prepareDirs('win32');
  assert.ok(existsSync(socketsDir()));
  delete process.env.SCOPEDOWN_HOME;
});
