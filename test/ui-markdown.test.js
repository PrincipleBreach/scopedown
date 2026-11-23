// The console renders agent-written Markdown. It must never turn text into live HTML,
// script links or remote image loads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;
globalThis.Node = document.defaultView.Node;
const { renderMarkdown } = await import('../src/ui/markdown.js');

test('HTML in agent text stays text', () => {
  const el = renderMarkdown('Hello <img src=x onerror=alert(1)> and <script>alert(2)</script>\n\n<b>bold?</b>');
  assert.equal(el.querySelectorAll('img, script, b').length, 0);
  assert.match(el.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('only http(s) links become links; images become links, never loads', () => {
  const el = renderMarkdown('[a](javascript:alert(1)) [b](https://example.com/x) ![shot](https://evil.example/p.png) <https://ok.example>');
  const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['https://example.com/x', 'https://evil.example/p.png', 'https://ok.example']);
  assert.equal(el.querySelectorAll('img').length, 0);
  for (const a of el.querySelectorAll('a')) assert.equal(a.getAttribute('rel'), 'noopener noreferrer nofollow');
});

test('structure: headings, lists, code, tables, quotes, attachments', () => {
  const md = '## Steps\n\n1. Log in\n2. Send `POST /x`\n\n```http\nGET / HTTP/1.1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\nSee {{attachment:poc.png}}.';
  const el = renderMarkdown(md, { attachment: (name) => { const s = document.createElement('span'); s.className = 'chip'; s.textContent = name; return s; } });
  assert.equal(el.querySelector('h3').textContent, 'Steps');
  assert.equal(el.querySelectorAll('ol li').length, 2);
  assert.equal(el.querySelector('li code').textContent, 'POST /x');
  assert.equal(el.querySelector('pre code').textContent, 'GET / HTTP/1.1');
  assert.equal(el.querySelectorAll('td').length, 2);
  assert.equal(el.querySelector('blockquote').textContent.trim(), 'quoted');
  assert.equal(el.querySelector('.chip').textContent, 'poc.png');
});
