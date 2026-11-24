// Turns a normalized program into one Markdown document an agent can read top to bottom:
// YAML front matter, key rules, scope tables, rewards, notes, then the program's own text.
// build() also returns the pieces the popup shows at a glance.

import { htmlToMarkdown, nestHeadings, tableCell, tidyMarkdown } from './markdown.js';

export const VERSION = '1.0.1';

export function render(p, opts) {
  return build(p, opts).markdown;
}

export function build(p, { parse }) {
  const md = (body, format, level) => {
    const text = format === 'html'
      ? htmlToMarkdown(body, { parse, baseUrl: p.url })
      : String(body || '').trim();
    return nestHeadings(tidyMarkdown(text), level);
  };

  const inScope = p.scopes.filter((s) => s.inScope);
  const outScope = p.scopes.filter((s) => !s.inScope);
  const top = topReward(p.rewards);
  const out = [];

  out.push(frontMatter({
    platform: p.platform,
    program: p.name,
    handle: p.handle,
    url: p.url,
    visibility: p.visibility,
    submissions: p.status,
    offers_bounties: p.bounties,
    top_reward: top ? top.label : null,
    ...Object.fromEntries(p.facts.map(([k, v]) => [snake(k), v])),
    in_scope_assets: inScope.length,
    out_of_scope_assets: outScope.length,
    policy_updated: day(p.updatedAt),
    fetched_at: p.fetchedAt.replace(/:\d\d(\.\d+)?Z$/, 'Z'),
    generator: `ScopeDown ${VERSION} by Principle Breach`,
  }));

  out.push(`# ${p.name}`);
  if (p.warnings.length) {
    out.push(p.warnings.map((w) => `> Warning from the platform API: ${w}`).join('\n>\n'));
  }

  // Converted once, then reused for rule detection and for the output.
  const sections = p.sections.map((s) => ({ title: s.title, body: md(s.body, s.format, 3) }));
  const groups = p.groups.map((g, id) => ({ ...g, id, body: md(g.notes, g.notesFormat, 4) }));
  const groupNotes = groups.filter((g) => g.body);

  // Assets that share the same note (common on HackerOne) get one entry, not one each.
  const assetNotes = new Map();
  for (const s of p.scopes.filter((x) => x.notes)) {
    const key = `${s.inScope}\n${s.notesFormat}\n${s.notes}`;
    if (!assetNotes.has(key)) assetNotes.set(key, { scopes: [], inScope: s.inScope, body: md(s.notes, s.notesFormat, 4) });
    assetNotes.get(key).scopes.push(s);
  }

  const rules = findRules([
    ...sections.map((s) => s.body),
    ...groupNotes.map((g) => g.body),
    ...[...assetNotes.values()].map((n) => n.body),
  ]);
  if (rules.length) {
    out.push('## Key rules (auto-detected)');
    out.push('Quoted from the program text below, which stays authoritative.');
    for (const r of rules) out.push(`**${r.label}**\n\n${r.lines.map((l) => `- ${l}`).join('\n')}`);
  }

  const none = { true: 'None listed.', false: 'None listed. The program text may still exclude targets.' };
  for (const [title, flag, list] of [['In scope', true, inScope], ['Out of scope', false, outScope]]) {
    out.push(`## ${title} (${list.length})`);
    if (!groups.length) {
      out.push(list.length ? scopeTable(list, flag) : none[flag]);
      continue;
    }
    // Bugcrowd: each scope group keeps its rewards, targets and notes together.
    let wrote = false;
    for (const g of groups.filter((x) => x.inScope === flag)) {
      const targets = list.filter((s) => s.groupId === g.id);
      if (!targets.length && !g.body && !g.rewards) continue;
      wrote = true;
      out.push(`### ${g.name}`);
      if (g.rewards) out.push(`Rewards: ${g.rewards}.`);
      if (targets.length) out.push(scopeTable(targets, flag, { grouped: true }));
      if (g.body) out.push(g.body);
    }
    if (!wrote) out.push(none[flag]);
  }

  if (!groups.length && p.rewards?.rows.length) {
    out.push('## Rewards');
    const head = [p.platform === 'bugcrowd' ? 'Scope group' : 'Applies to', ...p.rewards.columns];
    out.push(table(head, mergeRows(p.rewards.rows).map((r) => [r.label, ...r.cells.map((c) => c || '-')]), [0]));
    if (p.rewards.notes) out.push(md(p.rewards.notes, 'markdown', 3));
  }

  if (assetNotes.size) {
    out.push('## Asset notes');
    for (const n of assetNotes.values()) {
      out.push(`### ${n.scopes.map((s) => code(s.identifier)).join(', ')}${n.inScope ? '' : ' (out of scope)'}`);
      out.push(n.body);
    }
  }

  for (const s of sections) {
    if (!s.body) continue;
    out.push(`## ${s.title}`);
    out.push(s.body);
  }

  return {
    markdown: `${out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`,
    rules: rules.map((r) => ({ label: r.label, short: shortRule(r), lines: r.lines })),
    targets: webTargets(inScope),
    topReward: top,
    inScope: inScope.length,
    outScope: outScope.length,
  };
}

// Columns that carry the same value on every row are stated once above the table.
function scopeTable(scopes, inScope, { grouped = false } = {}) {
  let cols = [
    ['Asset', (s) => code(s.identifier)],
    ['Type', (s) => s.type],
    ['Location', (s) => (s.location || '').split(' ').filter(Boolean).map(code).join(' ')],
    ['Group', (s) => (grouped || scopes.every((x) => x.group === x.identifier) ? '' : s.group)],
    ['Bounty', (s) => (!inScope || grouped || s.bounty == null ? '' : s.bounty ? 'yes' : 'no')],
    ['Max severity', (s) => (inScope ? s.maxSeverity : '')],
    ['CVSS env', (s) => s.cia],
    ['Tech', (s) => (s.tags || []).join(', ')],
  ];
  const shared = [];
  cols = cols.filter(([head, f], i) => {
    if (i === 0) return true;
    const values = scopes.map((s) => f(s) || '');
    if (values.every((v) => !v)) return false;
    if (scopes.length > 1 && values.every((v) => v === values[0])) {
      shared.push(`${head.toLowerCase()} ${values[0]}`);
      return false;
    }
    return true;
  });
  const lead = shared.length ? `Every row: ${shared.join(', ')}.\n\n` : '';
  const raw = cols.map(([h], i) => (h === 'Asset' || h === 'Location' ? i : -1)).filter((i) => i >= 0);
  return lead + table(cols.map(([h]) => h), scopes.map((s) => cols.map(([, f]) => f(s))), raw);
}

// Reward rows with identical amounts collapse into one row listing every asset they cover.
function mergeRows(rows) {
  const merged = new Map();
  for (const r of rows) {
    const key = r.cells.join('|');
    if (merged.has(key)) merged.get(key).label += `, ${r.label}`;
    else merged.set(key, { label: r.label, cells: r.cells });
  }
  return [...merged.values()];
}

function table(head, rows, rawCols = []) {
  const cell = (v, i) => (rawCols.includes(i) ? String(v ?? '') : tableCell(v));
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

// Inline code that survives backticks and table pipes inside the value.
function code(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const fence = s.includes('`') ? '``' : '`';
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s.replace(/\|/g, '\\|')}${pad}${fence}`;
}

function topReward(rewards) {
  let max = 0;
  for (const r of rewards?.rows || []) {
    for (const c of r.cells) {
      for (const n of String(c).match(/\d[\d,]*/g) || []) max = Math.max(max, Number(n.replace(/,/g, '')));
    }
  }
  if (!max) return null;
  const sample = rewards.rows.flatMap((r) => r.cells).find((c) => c);
  const prefix = sample?.startsWith('$') ? '$' : (sample?.match(/^[A-Z]{3} /)?.[0] || '');
  return { amount: max, label: `${prefix}${max.toLocaleString('en-US')}` };
}

const WEB = /^(https?:\/\/)?(\*\.)?([a-z0-9*-]+\.)+[a-z0-9-]{2,}(:\d+)?(\/\S*)?$/i;
const IP = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$|^[0-9a-f:]+:[0-9a-f:]*(\/\d{1,3})?$/i;

// Domains, URLs, wildcards and IP ranges exactly as listed, for recon tools.
export function webTargets(scopes) {
  const seen = new Set();
  for (const s of scopes) {
    const candidates = WEB.test(s.identifier) || IP.test(s.identifier)
      ? [s.identifier]
      : (s.location || '').split(' ');
    for (const c of candidates) {
      const v = c.trim();
      if (v && (WEB.test(v) || IP.test(v) || /^https?:\/\/\S+$/i.test(v))) seen.add(v);
    }
  }
  return [...seen];
}

const DIRECTIVE = /\b(must|should|please|required?|include|add|use|set|append|send|only)\b/i;
const PROHIBIT = /\b(do not|don't|must not|should not|may not|cannot|can't|not allowed|not permitted|prohibited|forbidden|avoid|refrain|never|limit(ed)? to)\b/i;

const RULES = [
  {
    label: 'Identify your traffic',
    key: 'Header',
    test: (l) => /\bX-[A-Za-z0-9-]+\s*:\s*\S/.test(l)
      || (/\b(user[- ]agent|http header|custom header|request header|header)\b/i.test(l) && DIRECTIVE.test(l)),
    short: (l) => l.match(/\bX-[A-Za-z0-9-]+\s*:\s*[^\s`·|,;]+/)?.[0]
      || (/\buser[- ]agent\b/i.test(l) ? 'Custom User-Agent' : null),
  },
  {
    label: 'Test accounts',
    key: 'Email',
    test: (l) => /wearehackerone|bugcrowdninja/i.test(l),
    short: (l) => `you@${l.match(/(wearehackerone|bugcrowdninja)\.com/i)?.[0]?.toLowerCase() || 'platform alias'}`,
  },
  {
    label: 'Rate limits',
    key: 'Rate',
    test: (l) => /\b\d+\s*(requests?|reqs?|queries|calls)\s*(per|\/|a|each)\s*(second|sec|s|minute|min|hour)\b/i.test(l)
      || /\b\d+\s*(rps|req\/s|requests\/s)\b/i.test(l)
      || /\brequests? per (second|minute)\b/i.test(l),
    short: (l) => l.match(/\b\d+\s*(requests?|reqs?|queries|calls|rps|req\/s)(\s*(per|\/|a|each)\s*(second|sec|s|minute|min|hour))?\b/i)?.[0],
  },
  {
    label: 'Automated testing',
    key: 'Automation',
    test: (l) => /\b(automated|automation|scanners?|scanning|fuzz\w*|brute[- ]?forc\w*|dos|ddos|denial of service)\b/i.test(l)
      && PROHIBIT.test(l),
    short: () => null,
  },
];

function findRules(texts) {
  const found = RULES.map((r) => ({ rule: r, label: r.label, lines: [] }));
  const seen = new Set();
  for (const text of texts) {
    let fence = false;
    for (const raw of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
      if (fence || /^\s*#/.test(raw) || /^\s*\|?\s*-{3,}/.test(raw)) continue;
      for (const sentence of sentences(raw)) {
        RULES.forEach((r, i) => {
          const key = sentence.toLowerCase();
          if (found[i].lines.length < 6 && !seen.has(key) && r.test(sentence)) {
            seen.add(key);
            found[i].lines.push(sentence);
          }
        });
      }
    }
  }
  return found.filter((r) => r.lines.length);
}

// A short, glanceable value for the popup: the header, the email domain, or the first sentence.
function shortRule(r) {
  for (const line of r.lines) {
    const v = r.rule.short(line);
    if (v) return { key: r.rule.key, value: v.trim(), mono: r.rule.key !== 'Automation' };
  }
  // The shortest quoted sentence is usually the direct rule ("Do not run scanners."), not its context.
  let plain = [...r.lines].sort((a, b) => a.length - b.length)[0].replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Table rows arrive as "Label · Text"; the popup already shows its own label.
  const cells = plain.split(' · ');
  if (cells.length > 1 && cells[0].split(' ').length <= 3) plain = cells.slice(1).join(' · ');
  return { key: r.rule.key, value: plain, mono: false };
}

function sentences(line) {
  let l = line.trim().replace(/^>\s?/, '').replace(/^([-*+]|\d+[.)])\s+/, '');
  if (l.startsWith('|')) l = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ');
  if (!l) return [];
  const parts = l.length > 240 ? l.split(/(?<=[.!?])\s+(?=[A-Z*_`"(])/) : [l];
  return parts.map((s) => s.trim()).filter((s) => s.length > 8).map((s) => (s.length > 400 ? `${s.slice(0, 397)}...` : s));
}

function snake(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function day(iso) {
  return iso ? String(iso).slice(0, 10) : null;
}

function frontMatter(obj) {
  const lines = Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
  return `---\n${lines.join('\n')}\n---`;
}
