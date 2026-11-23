import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown, tidyMarkdown } from '../src/markdown.js';
import { parse } from './helpers.js';

test('tidyMarkdown drops link titles and self-links, nothing else', () => {
  assert.equal(tidyMarkdown('See [https://github.com](https://github.com "https://github.com").'), 'See <https://github.com>.');
  assert.equal(tidyMarkdown('[docs](https://x.io/d "Docs") and [x.io](https://x.io)'), '[docs](https://x.io/d) and [x.io](https://x.io)');
  assert.equal(tidyMarkdown('[a@b.co](mailto:a@b.co)'), '<a@b.co>');
  assert.equal(tidyMarkdown('text   \n\n\n\nmore'), 'text\n\nmore');
  assert.equal(tidyMarkdown('```\n[keep](x "y")   \n```'), '```\n[keep](x "y")   \n```');
});

test('self-links from HTML become autolinks even with a trailing slash', () => {
  const md = htmlToMarkdown('<a href="https://personal.trexcloud.com/">https://personal.trexcloud.com</a>', { parse });
  assert.equal(md, '<https://personal.trexcloud.com/>');
});
