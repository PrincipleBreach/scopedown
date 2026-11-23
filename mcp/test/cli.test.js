// The command line, run as a user runs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CLI = new URL('../bin/scopedown-mcp.js', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('--version prints the package version, and help names it', () => {
  for (const flag of ['--version', '-v', 'version']) assert.equal(run(flag).trim(), version, flag);
  assert.match(run('--help'), new RegExp(`^scopedown-mcp ${version.replaceAll('.', '\\.')},`));
});

test('the MCP server reports the package version', async () => {
  const { VERSION } = await import('../src/version.js');
  assert.equal(VERSION, version);
});
