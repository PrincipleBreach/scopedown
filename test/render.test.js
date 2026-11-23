import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, outsideFences, section, words, parse } from './helpers.js';
import { tidyMarkdown } from '../src/markdown.js';

const TOP = ['Key rules (auto-detected)', 'In scope', 'Out of scope', 'Rewards',
  'Asset notes', 'Policy', 'Program overview', 'Targets overview', 'Additional information'];

// Expected scope straight from the raw API JSON, without the extension's normalizer.
function expected(f) {
  if (f.file.startsWith('hackerone')) {
    const nodes = f.raw.team.structured_scopes.nodes;
    return {
      inScope: nodes.filter((n) => n.eligible_for_submission).map((n) => n.asset_identifier.trim()),
      outScope: nodes.filter((n) => !n.eligible_for_submission).map((n) => n.asset_identifier.trim()),
    };
  }
  const groups = f.raw.brief.data.scope;
  const names = (g) => g.targets.map((t) => t.name.trim().replace(/\\([*_`\\])/g, '$1'));
  return {
    inScope: groups.filter((g) => g.inScope).flatMap(names),
    outScope: groups.filter((g) => !g.inScope).flatMap(names),
  };
}

for (const f of fixtures()) {
  const { markdown: out, program } = f;
  const exp = expected(f);

  test(`${f.file}: front matter is valid and matches the API counts`, () => {
    const m = out.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, 'front matter block');
    const fm = Object.fromEntries(m[1].split('\n').map((l) => {
      const i = l.indexOf(': ');
      return [l.slice(0, i), JSON.parse(l.slice(i + 2))];
    }));
    assert.equal(fm.in_scope_assets, exp.inScope.length);
    assert.equal(fm.out_of_scope_assets, exp.outScope.length);
    assert.equal(fm.platform, f.file.split('-')[0]);
    assert.match(fm.url, /^https:\/\/(hackerone|bugcrowd)\.com\//);
  });

  test(`${f.file}: every asset lands in the right table`, () => {
    for (const [title, ids] of [['In scope', exp.inScope], ['Out of scope', exp.outScope]]) {
      const body = section(out, title);
      const rows = body.split('\n').filter((l) => l.startsWith('| `'));
      assert.equal(rows.length, ids.length, `${title} row count`);
      for (const id of ids) {
        const cell = `\`${id.replace(/\s+/g, ' ').replace(/\|/g, '\\|')}\``;
        assert.ok(rows.some((r) => r.startsWith(`| ${cell} |`) || r.startsWith(`| \`\`${id}`)), `${title}: ${id}`);
      }
    }
  });

  test(`${f.file}: one H1 and only known level-2 headings`, () => {
    const lines = outsideFences(out);
    assert.equal(lines.filter((l) => /^# /.test(l)).length, 1);
    for (const h of lines.filter((l) => /^## /.test(l))) {
      assert.ok(TOP.some((t) => h === `## ${t}` || h.startsWith(`## ${t} (`)), `unexpected heading: ${h}`);
    }
  });

  test(`${f.file}: tables have a consistent column count`, () => {
    const cols = (l) => l.replace(/\\\|/g, '').split('|').length;
    let width = null;
    for (const l of outsideFences(out)) {
      if (!l.startsWith('|')) { width = null; continue; }
      if (width == null) width = cols(l);
      else assert.equal(cols(l), width, `ragged row: ${l.slice(0, 80)}`);
    }
  });

  test(`${f.file}: no policy text is lost`, () => {
    const sources = f.file.startsWith('hackerone')
      ? [f.raw.team.policy, ...f.raw.team.structured_scopes.nodes.map((n) => n.instruction)]
      : (() => {
        const d = f.raw.brief.data;
        const html = [d.brief.description, d.brief.targetsOverview, d.brief.additionalInformation,
          ...d.scope.map((g) => g.descriptionHtml)].filter(Boolean);
        return html.map((h) => parse(h).body.textContent);
      })();
    const have = new Map();
    for (const w of words(out)) have.set(w, (have.get(w) || 0) + 1);
    const need = new Map();
    for (const w of sources.filter(Boolean).flatMap(words)) need.set(w, (need.get(w) || 0) + 1);
    const missing = [...need].filter(([w, n]) => (have.get(w) || 0) < (f.file.startsWith('hackerone') ? 1 : n));
    assert.deepEqual(missing, []);
  });

  if (f.file.startsWith('hackerone')) {
    test(`${f.file}: every policy line is kept verbatim`, () => {
      const outLines = new Set(out.split('\n').map((l) => l.replace(/^#+(?=\s)/, '').trim()));
      // The only change allowed is the lossless tidy (link titles, self-links, trailing spaces).
      for (const line of tidyMarkdown(f.raw.team.policy).split('\n')) {
        const want = line.replace(/^\s{0,3}#+(?=\s)/, '').trim();
        if (want) assert.ok(outLines.has(want), `missing policy line: ${want.slice(0, 80)}`);
      }
    });
  }

  test(`${f.file}: no raw HTML left in the Markdown`, () => {
    const prose = outsideFences(out).join('\n').replace(/`[^`]*`/g, '');
    assert.doesNotMatch(prose, /<\/?(p|div|span|h[1-6]|ul|ol|li|strong|em|br|table|tr|td)\b[^>]*>/i);
  });
}

test('rule detection finds the platform test identities', () => {
  const all = Object.fromEntries(fixtures().map((f) => [f.file, f.markdown]));
  const rules = (file) => section(all[file], 'Key rules');
  assert.match(rules('hackerone-security.json'), /X-Bug-Bounty: HackerOne-<username>/);
  assert.match(rules('hackerone-security.json'), /@wearehackerone\.com/);
  assert.match(rules('bugcrowd-tesla.json'), /bugcrowdninja/);
  assert.match(rules('bugcrowd-zendesk.json'), /bugcrowdninja/);
  assert.doesNotMatch(rules('bugcrowd-zendesk.json'), /WebCache poisoning/);
});

test('Bugcrowd markdown escapes are removed from target names', () => {
  const z = fixtures().find((f) => f.file === 'bugcrowd-zendesk.json');
  assert.ok(z.program.scopes.some((s) => s.identifier === '*.zdassets.com'));
});
