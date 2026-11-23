import { readFileSync, readdirSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import * as hackerone from '../src/platforms/hackerone/program.js';
import * as bugcrowd from '../src/platforms/bugcrowd/program.js';
import { render } from '../src/render.js';

// linkedom needs a full document for text/html; the browser DOMParser does not.
export const parse = (html) => new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');

const dir = new URL('./fixtures/', import.meta.url);

export function fixtures() {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((file) => {
    const raw = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const platform = file.startsWith('hackerone') ? hackerone : bugcrowd;
    const program = platform.normalize(raw, { fetchedAt: '2026-11-23T00:00:00.000Z' });
    return { file, raw, platform, program, markdown: render(program, { parse }) };
  });
}

// Headings and lines outside fenced code blocks.
export function outsideFences(md) {
  const lines = [];
  let fence = null;
  for (const line of md.split('\n')) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}

// The body of one "## Title" section, up to the next level-2 heading.
export function section(md, title) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l === `## ${title}` || l.startsWith(`## ${title} (`));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

export function words(text) {
  return (text.normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) || []).map((w) => w.toLowerCase());
}
