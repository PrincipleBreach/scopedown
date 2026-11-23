import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, shiftHeadings, nestHeadings, tidyMarkdown } from '../src/markdown.js';
import { parse } from './helpers.js';

const md = (html, opts = {}) => htmlToMarkdown(html, { parse, ...opts });

test('headings, paragraphs and inline formatting', () => {
  assert.equal(md('<h1>Overview</h1><p>Hello <strong> world </strong>and <em>you</em>.</p>'),
    '# Overview\n\nHello **world** and _you_.');
});

test('heading offset caps at level 6', () => {
  assert.equal(md('<h2>A</h2><h5>B</h5>', { headingOffset: 2 }), '#### A\n\n###### B');
});

test('nested lists keep their structure', () => {
  const out = md('<ul><li>One<ul><li>Inner <b>bold</b></li></ul></li><li><p>Two</p></li></ul><ol start="3"><li>Three</li></ol>');
  assert.equal(out, '- One\n  - Inner **bold**\n- Two\n\n3. Three');
});

test('links resolve against the program URL and drop javascript links', () => {
  const out = md('<a href="/engagements/x/rules">rules</a> <a href="javascript:alert(1)">bad</a> <a href="mailto:a@b.co">a@b.co</a>',
    { baseUrl: 'https://bugcrowd.com/engagements/x' });
  assert.equal(out, '[rules](https://bugcrowd.com/engagements/x/rules) bad <a@b.co>');
});

test('pre blocks keep whitespace, inline code collapses', () => {
  const out = md('<p>Use <code>X-Bug-Bounty:  me</code></p><pre><code>GET / HTTP/1.1\n  Host: a\n</code></pre>');
  assert.equal(out, 'Use `X-Bug-Bounty: me`\n\n```\nGET / HTTP/1.1\n  Host: a\n```');
});

test('tables become pipe tables with escaped pipes', () => {
  const out = md('<table><thead><tr><th>P</th><th>Reward</th></tr></thead><tbody><tr><td>P1</td><td>$1 | $2</td></tr><tr><td>P2</td></tr></tbody></table>');
  assert.equal(out, '| P | Reward |\n| --- | --- |\n| P1 | $1 \\| $2 |\n| P2 | |');
});

test('odd whitespace and line breaks', () => {
  assert.equal(md('<p>\u2001<br>\nUse your&nbsp;alias\u200b<br>please</p>'), 'Use your alias\nplease');
});

test('blockquotes and horizontal rules', () => {
  assert.equal(md('<blockquote><p>Note</p><p>Two</p></blockquote><hr>'), '> Note\n>\n> Two\n\n---');
});

test('scripts and styles are dropped', () => {
  assert.equal(md('<p>a</p><script>alert(1)</script><style>p{}</style>'), 'a');
});

test('shiftHeadings skips fenced code', () => {
  assert.equal(shiftHeadings('# A\n```\n# not a heading\n```\n## B', 2), '### A\n```\n# not a heading\n```\n#### B');
});

test('nestHeadings moves the shallowest heading to the target level', () => {
  assert.equal(nestHeadings('### A\n#### B', 3), '### A\n#### B');
  assert.equal(nestHeadings('# A\n### B', 3), '### A\n##### B');
  assert.equal(nestHeadings('no headings', 3), 'no headings');
});
