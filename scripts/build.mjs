// Builds store-ready zips: dist/scopedown-<version>-chrome.zip and -firefox.zip.
// The repository manifest is the Chromium development one (it has a "key" for a stable unpacked
// ID). Each store gets only what it supports, so neither warns: Firefox gets an event page.
// Usage: node scripts/build.mjs [--check]   (--check validates the release manifests without fonts or zips)

import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;

// The Chrome Web Store rejects an upload whose manifest breaks these limits.
for (const [field, max] of Object.entries({ name: 75, description: 132 })) {
  const length = [...(manifest[field] ?? '')].length;
  if (length > max) throw new Error(`manifest.json ${field} is ${length} characters; the Chrome Web Store allows ${max}.`);
}

const check = process.argv.includes('--check');
if (!check) execFileSync(process.execPath, [join(root, 'scripts/fonts.mjs')], { stdio: 'inherit' });

const targets = {
  chrome(m) {
    delete m.key;
    delete m.browser_specific_settings;
    return m;
  },
  firefox(m) {
    delete m.key;
    m.background = { scripts: [m.background.service_worker], type: m.background.type };
    m.permissions = m.permissions.filter((p) => p !== 'offscreen');
    return m;
  },
};

for (const [name, transform] of Object.entries(targets)) {
  const stage = join(dist, name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'icons'), { recursive: true });
  mkdirSync(join(stage, 'fonts'), { recursive: true });
  cpSync(join(root, 'src'), join(stage, 'src'), { recursive: true });
  if (name === 'firefox') {
    // Firefox's background page has a DOM, so the offscreen document is Chrome-only.
    rmSync(join(stage, 'src/offscreen.html'));
    rmSync(join(stage, 'src/offscreen.js'));
  }
  for (const f of ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png', 'pb-mark.png', 'pb-mark-light.png']) {
    cpSync(join(root, 'icons', f), join(stage, 'icons', f));
  }
  for (const f of ['switzer-400-normal.woff2', 'switzer-500-normal.woff2', 'jetbrains-mono-latin.woff2', 'LICENSE-JetBrainsMono.txt']) {
    if (!existsSync(join(root, 'fonts', f))) {
      if (check) continue;
      throw new Error(`fonts/${f} is missing. Run npm run fonts.`);
    }
    cpSync(join(root, 'fonts', f), join(stage, 'fonts', f));
  }
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(transform(structuredClone(manifest)), null, 2)}\n`);
  if (check) continue;
  const zip = join(dist, `scopedown-${version}-${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-X', '-r', zip, '.'], { cwd: stage });
  console.log(`Built ${zip}`);
}

execFileSync(join(root, 'node_modules/.bin/web-ext'), ['lint', '--source-dir', join(dist, 'firefox'), '--warnings-as-errors'], { stdio: 'inherit' });
