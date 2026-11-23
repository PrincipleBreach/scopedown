// Prints the Markdown the popup would produce for a saved fixture.
// Usage: node scripts/render-fixture.mjs test/fixtures/hackerone-security.json
import { readFile } from 'node:fs/promises';
import { DOMParser } from 'linkedom';
import * as hackerone from '../src/platforms/hackerone/program.js';
import * as bugcrowd from '../src/platforms/bugcrowd/program.js';
import { render } from '../src/render.js';

const file = process.argv[2];
const raw = JSON.parse(await readFile(file, 'utf8'));
const platform = file.includes('hackerone') ? hackerone : bugcrowd;
const program = platform.normalize(raw, { fetchedAt: '2026-11-23T00:00:00.000Z' });
const parse = (html) => new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
process.stdout.write(render(program, { parse }));
