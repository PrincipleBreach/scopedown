import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures, section, parse } from './helpers.js';
import { build } from '../src/render.js';

// Reads the In scope section back into per-asset facts: each row's cells, plus the
// "Every row:" line, the group heading and the group's reward line that apply to it.
function readTables(body) {
  const facts = new Map();
  let shared = {};
  let head = null;
  let group = null;
  let rewards = null;
  for (const line of body.split('\n')) {
    if (line.startsWith('### ')) {
      group = line.slice(4);
      rewards = null;
      shared = {};
      continue;
    }
    const rw = line.match(/^Rewards: (.*)\.$/);
    if (rw) {
      rewards = rw[1];
      continue;
    }
    const every = line.match(/^Every row: (.*)\.$/);
    if (every) {
      shared = {};
      for (const part of every[1].split(', ')) {
        const m = part.match(/^(type|location|group|bounty|max severity|cvss env|tech) (.*)$/);
        if (m) shared[m[1]] = m[2];
      }
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cells[0] === 'Asset') {
      head = cells.map((h) => h.toLowerCase());
      continue;
    }
    if (/^-+$/.test(cells[0])) continue;
    const row = { ...shared, group, rewards };
    head.forEach((h, i) => { row[h] = cells[i]; });
    facts.set(row.asset.replace(/^`+ ?| ?`+$/g, ''), row);
  }
  return facts;
}

for (const f of fixtures()) {
  test(`${f.file}: per-asset facts survive column folding and grouping`, () => {
    const rows = readTables(section(f.markdown, 'In scope'));
    if (f.file.startsWith('hackerone')) {
      for (const n of f.raw.team.structured_scopes.nodes.filter((x) => x.eligible_for_submission)) {
        const id = n.asset_identifier.trim();
        const row = rows.get(id);
        assert.ok(row, `row for ${id}`);
        assert.equal(row.bounty, n.eligible_for_bounty ? 'yes' : 'no', `bounty for ${id}`);
        assert.equal(row['max severity'], n.max_severity, `severity for ${id}`);
      }
      return;
    }
    for (const g of f.raw.brief.data.scope.filter((x) => x.inScope)) {
      for (const t of g.targets) {
        const id = t.name.trim().replace(/\\([*_`\\])/g, '$1');
        const row = rows.get(id);
        assert.ok(row, `row for ${id}`);
        assert.equal(row.group, g.name.trim(), `group for ${id}`);
        const p1 = g.rewardRangeData?.['1']?.max;
        if (p1) assert.ok(row.rewards.includes(`$${p1.toLocaleString('en-US')}`), `P1 max for ${id}`);
      }
    }
  });
}

test('build() gives the popup glanceable rules, targets and top reward', () => {
  const all = Object.fromEntries(fixtures().map((f) => [f.file, { f, out: build(f.program, { parse }) }]));

  const sec = all['hackerone-security.json'].out;
  const short = Object.fromEntries(sec.rules.map((r) => [r.short.key, r.short.value]));
  assert.equal(short.Header, 'X-Bug-Bounty: HackerOne-<username>');
  assert.equal(short.Email, 'you@wearehackerone.com');
  assert.equal(sec.topReward.label, '$15,000');
  assert.ok(sec.targets.includes('hackerone.com'));
  assert.ok(!sec.targets.includes('support.hackerone.com'), 'out-of-scope host must not be a target');

  const { f: teslaFixture, out: tesla } = all['bugcrowd-tesla.json'];
  const teslaShort = Object.fromEntries(tesla.rules.map((r) => [r.short.key, r.short.value]));
  assert.equal(teslaShort.Email, 'you@bugcrowdninja.com');
  const maxPaid = Math.max(...teslaFixture.raw.brief.data.scope
    .filter((g) => g.inScope)
    .flatMap((g) => Object.values(g.rewardRangeData || {}).map((v) => v?.max || 0)));
  assert.equal(tesla.topReward.amount, maxPaid);
});
