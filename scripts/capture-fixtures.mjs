// Runs the extension's own in-page fetchers from Node against public programs and saves
// the raw responses as test fixtures. Usage: npm run fixtures [-- h1:<handle> bc:<code> ...]
// Only public programs belong here. Private program data must never be committed.

import { writeFile, mkdir } from 'node:fs/promises';
import { DOMParser, parseHTML } from 'linkedom';
import * as hackerone from '../src/platforms/hackerone/program.js';
import * as bugcrowd from '../src/platforms/bugcrowd/program.js';

const DEFAULT = ['h1:security', 'h1:github', 'h1:shopify', 'h1:gitlab', 'bc:tesla', 'bc:okta', 'bc:zendesk', 'bc:openai-safety'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const realFetch = globalThis.fetch;
const out = new URL('../test/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });

for (const t of targets) {
  const [kind, id] = t.split(':');
  const origin = kind === 'h1' ? 'https://hackerone.com' : 'https://bugcrowd.com';
  const page = kind === 'h1' ? `${origin}/${id}` : `${origin}/engagements/${id}`;

  // Pretend to be the program page: same globals the in-page function reads.
  const html = await (await realFetch(page, { headers: { 'User-Agent': 'Mozilla/5.0 ScopeDown-fixtures' } })).text();
  const { document } = parseHTML(html);
  globalThis.document = document;
  globalThis.DOMParser = DOMParser;
  globalThis.location = new URL(page);
  globalThis.fetch = (input, init = {}) => realFetch(new URL(input, origin), {
    ...init,
    headers: { 'User-Agent': 'Mozilla/5.0 ScopeDown-fixtures', ...init.headers },
  });

  const platform = kind === 'h1' ? hackerone : bugcrowd;
  const target = platform.match(new URL(page));
  const raw = await platform.fetchInPage(...platform.inPageArgs(target));
  globalThis.fetch = realFetch;
  if (raw.error) {
    console.error(`${t}: ${raw.error}`);
    process.exitCode = 1;
    continue;
  }
  const file = `${kind === 'h1' ? 'hackerone' : 'bugcrowd'}-${id}.json`;
  await writeFile(new URL(file, out), `${JSON.stringify(raw, null, 1)}\n`);
  console.log(`${t}: saved ${file}`);
}
