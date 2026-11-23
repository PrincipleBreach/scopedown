// Evidence files: chunked transfer through the real host and server, the secret-file
// refusals, and waiting for a review decision with short polls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodeNative, nativeDecoder } from '../src/framing.js';
import { readEvidence } from '../src/files.js';

const CLI = new URL('../bin/scopedown-mcp.js', import.meta.url).pathname;

test('evidence types and sizes are enforced; any folder is fine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  const ok = join(dir, 'poc-screenshot.png');
  writeFileSync(ok, 'png');
  assert.equal(readEvidence(ok).name, 'poc-screenshot.png');
  mkdirSync(join(dir, '.cache'));
  writeFileSync(join(dir, '.cache', 'session.har'), '{}');
  assert.equal(readEvidence(join(dir, '.cache', 'session.har')).name, 'session.har');
  writeFileSync(join(dir, 'notes.exe'), 'x');
  assert.throws(() => readEvidence(join(dir, 'notes.exe')), /allowed evidence type/);
  writeFileSync(join(dir, 'empty.txt'), '');
  assert.throws(() => readEvidence(join(dir, 'empty.txt')), /1 byte to 20 MB/);
  assert.throws(() => readEvidence(join(dir, 'missing.png')), /does not exist/);
});

test('attach_file sends a file in chunks the extension can verify, and get_draft waits by polling', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scopedown-'));
  const host = spawn(process.execPath, [CLI, 'host'], { env: { ...process.env, SCOPEDOWN_HOME: home } });
  const uploads = {};
  const stored = [];
  let polls = 0;
  let biggest = 0;
  host.stdout.on('data', nativeDecoder((msg) => {
    if (msg.type !== 'request') return;
    biggest = Math.max(biggest, JSON.stringify(msg).length);
    const ok = (result) => host.stdin.write(encodeNative({ type: 'response', id: msg.id, ok: true, result }));
    const p = msg.params;
    if (msg.op === 'draft_report') return ok({ draft_id: 'd_1', status: 'pending_review', attachments: [] });
    if (msg.op === 'attach_begin') { uploads.u1 = { ...p, parts: [] }; return ok({ upload_id: 'u1', chunk_bytes: 256 * 1024 }); }
    if (msg.op === 'attach_chunk') { uploads[p.upload_id].parts[p.index] = Buffer.from(p.data, 'base64'); return ok({}); }
    if (msg.op === 'attach_end') {
      const u = uploads[p.upload_id];
      const bytes = Buffer.concat(u.parts);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), u.sha256);
      stored.push({ name: u.name, size: bytes.length });
      return ok({ draft_id: 'd_1', status: 'pending_review', attachments: stored });
    }
    if (msg.op === 'get_draft' && p.wait_seconds === undefined) return ok({ draft_id: 'd_1', status: 'pending_review', attachments: stored });
    if (msg.op === 'get_draft') {
      polls++;
      assert.ok(p.wait_seconds <= 20, 'each browser request waits at most 20 s');
      return ok({ draft_id: 'd_1', status: polls < 3 ? 'pending_review' : 'submitted', report: polls < 3 ? undefined : { url: 'https://hackerone.com/reports/1' } });
    }
    return ok({});
  }));
  host.stdin.write(encodeNative({ type: 'hello', extension: { version: 't', browser: 'Brave', install: 'x' } }));
  const sockets = join(home, 'sockets');
  for (let i = 0; i < 200 && !(existsSync(sockets) && readdirSync(sockets).some((f) => f.endsWith('.sock'))); i++) await new Promise((r) => setTimeout(r, 25));

  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  const video = join(dir, 'poc.mp4');
  writeFileSync(video, randomBytes(1_300_000));
  const client = new Client({ name: 'files-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI], env: { ...process.env, SCOPEDOWN_HOME: home } }));
  try {
    const out = await client.callTool({ name: 'draft_report', arguments: { platform: 'hackerone', handle: 'x', title: 'Stored XSS in profile names', severity: 'low', description: 'd'.repeat(100), impact: 'Script runs for viewers.', attachments: [video] } });
    const draft = JSON.parse(out.content[0].text);
    assert.deepEqual(draft.attachments, [{ name: 'poc.mp4', size: 1_300_000 }]);
    assert.ok(biggest < 1024 * 1024, `largest message ${biggest} bytes stays under the 1 MB native messaging cap`);

    const bad = await client.callTool({ name: 'draft_report', arguments: { platform: 'hackerone', handle: 'x', title: 'Stored XSS in profile names', severity: 'low', description: 'd'.repeat(100), impact: 'Script runs for viewers.', attachments: [join(dir, 'missing-file.png')] } });
    assert.equal(bad.isError, true, 'a bad path refuses the whole call before any draft exists');

    const started = Date.now();
    const done = await client.callTool({ name: 'get_draft', arguments: { draft_id: 'd_1', wait_seconds: 120 } });
    assert.equal(JSON.parse(done.content[0].text).status, 'submitted');
    assert.equal(polls, 3);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await client.close();
    host.kill();
  }
});
