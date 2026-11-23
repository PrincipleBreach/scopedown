// Wire formats between the browser, the native host and the MCP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLine, lineDecoder, encodeNative, nativeDecoder } from '../src/framing.js';

// Program text and reports carry any language and emoji. A socket read can end in the middle of
// a character, so every split point must give the same text back.
const message = { title: 'Gwalior ग्वालियर · 東京 · Zürich · 🔥 report', body: 'ü'.repeat(50) };

test('a JSON line survives being split at any byte', () => {
  const bytes = Buffer.from(encodeLine(message), 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = [];
    const feed = lineDecoder((m) => got.push(m));
    feed(bytes.subarray(0, cut));
    feed(bytes.subarray(cut));
    assert.deepEqual(got, [message], `split at byte ${cut}`);
  }
});

test('a native message survives being split at any byte', () => {
  const bytes = encodeNative(message);
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = [];
    const feed = nativeDecoder((m) => got.push(m));
    feed(bytes.subarray(0, cut));
    feed(bytes.subarray(cut));
    assert.deepEqual(got, [message], `split at byte ${cut}`);
  }
});
