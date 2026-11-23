// Fetches Switzer, the Principle Breach brand typeface, from Fontshare (its official source) and
// checks each file against a pinned SHA-256. The ITF Free Font License lets Principle Breach
// embed it in its own application but not redistribute the files, so they are not committed.
// Usage: node scripts/fonts.mjs

import { createHash } from 'node:crypto';
import { writeFile, readFile, mkdir } from 'node:fs/promises';

const CSS = 'https://api.fontshare.com/v2/css?f[]=switzer@400,500&display=swap';
const FILES = {
  400: { out: 'switzer-400-normal.woff2', sha256: 'ddd9595560c35725e00d01667ce9bee519d245620e610844f0dd149df10b5d5f' },
  500: { out: 'switzer-500-normal.woff2', sha256: '7393d1abac009ede0da9f95d6c83479a08d798e28d3509575e02fb1d2346866f' },
};
const dir = new URL('../fonts/', import.meta.url);
await mkdir(dir, { recursive: true });

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// Skip the download when the pinned files are already in place.
const have = await Promise.all(Object.values(FILES).map((f) => readFile(new URL(f.out, dir)).then((b) => sha(b) === f.sha256, () => false)));
if (have.every(Boolean)) {
  console.log('Switzer already present and verified.');
  process.exit(0);
}

const css = await (await fetch(CSS)).text();
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
for (const [weight, file] of Object.entries(FILES)) {
  const face = faces.find((f) => new RegExp(`font-weight:\\s*${weight}\\b`).test(f));
  const url = face?.match(/url\('([^']+\.woff2)'\)/)?.[1];
  if (!url) throw new Error(`Fontshare did not list Switzer ${weight} as woff2.`);
  const bytes = Buffer.from(await (await fetch(url.startsWith('//') ? `https:${url}` : url)).arrayBuffer());
  if (sha(bytes) !== file.sha256) throw new Error(`Switzer ${weight} from Fontshare does not match the pinned file. Check the font and update the hash on purpose.`);
  await writeFile(new URL(file.out, dir), bytes);
  console.log(`Fetched and verified ${file.out}`);
}
