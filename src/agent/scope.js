// Decides whether a host, URL, IP or CIDR range is in a program's scope.
// Pure functions, shared by the extension and the tests.
//
// Rules:
// - A host asset ("api.example.com") covers that host on any path and port.
// - A wildcard ("*.example.com", "https://*.example.com/") covers subdomains at any depth,
//   not the apex. Bugcrowd's "{subdomain}" placeholder counts as a wildcard label.
// - A URL asset with a path ("https://example.com/app") covers that host; a target under the
//   path matches fully, anything else on the host matches with a note.
// - IPv4 addresses and CIDR ranges match by containment.
// - Other asset types (apps, source code, free text) match only on the exact identifier.
// - When both an in-scope and an out-of-scope asset match, the more specific one wins;
//   on a tie, out of scope wins.

export function checkScope(scopes, target) {
  const t = parseTarget(target);
  if (!t) return { target, verdict: 'not_listed', reason: 'Not a host, URL, IP address or CIDR range.' };

  let best = { in: null, out: null };
  for (const asset of scopes) {
    for (const pattern of patternsFor(asset)) {
      const m = matchPattern(pattern, t);
      if (!m) continue;
      const side = asset.inScope ? 'in' : 'out';
      if (!best[side] || m.score > best[side].score) best[side] = { ...m, asset, pattern };
    }
  }

  const winner = best.out && (!best.in || best.out.score >= best.in.score) ? best.out : best.in;
  if (!winner) {
    return { target, verdict: 'not_listed', reason: 'No listed asset covers this target. Treat it as out of scope.' };
  }
  const a = winner.asset;
  const result = {
    target,
    verdict: a.inScope ? 'in_scope' : 'out_of_scope',
    asset: a.identifier,
    asset_type: a.type || undefined,
    match: winner.kind,
  };
  if (a.inScope) {
    if (a.bounty != null) result.bounty = a.bounty;
    if (a.maxSeverity) result.max_severity = a.maxSeverity;
  }
  if (winner.note) result.note = winner.note;
  if (a.inScope && best.out) result.note = [result.note, `More general out-of-scope asset also matches: ${best.out.asset.identifier}.`].filter(Boolean).join(' ');
  if (!a.inScope && best.in) result.note = `Out-of-scope asset ${a.identifier} overrides in-scope asset ${best.in.asset.identifier}.`;
  return result;
}

// Target: { host, path, ip (number) | null, cidr: [base, bits] | null, raw }.
export function parseTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const cidr = parseCidr(raw);
  if (cidr) return { raw, host: null, path: '/', ip: null, cidr };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return { raw, host: null, path: '/', ip: null, cidr: null, text: raw.toLowerCase() };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || !/[a-z0-9]/.test(host)) return { raw, host: null, path: '/', ip: null, cidr: null, text: raw.toLowerCase() };
  return { raw, host, path: url.pathname || '/', ip: parseIp(host), cidr: null, text: raw.toLowerCase() };
}

// One asset can yield several patterns: its identifier and, on Bugcrowd, its URI or IP field.
export function patternsFor(asset) {
  const out = [];
  for (const value of [asset.identifier, ...String(asset.location || '').split(/\s+/)]) {
    const p = parsePattern(value);
    if (p) out.push(p);
  }
  return out;
}

export function parsePattern(value) {
  let v = String(value || '').trim().replace(/\{[^}]*\}/g, '*');
  if (!v) return null;
  const cidr = parseCidr(v);
  if (cidr) return { kind: 'cidr', cidr };
  const ip = parseIp(v);
  if (ip != null) return { kind: 'cidr', cidr: [ip, 32] };

  // Strip scheme and port, keep the path.
  const m = v.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/\s?#]+)(\/[^\s?#]*)?/i);
  if (!m) return { kind: 'exact', text: v.toLowerCase() };
  let host = m[1].toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const path = m[2] && m[2] !== '/' ? m[2].replace(/\*+$/, '') : '';

  if (!/^[a-z0-9*.-]+$/.test(host) || !host.includes('.')) return { kind: 'exact', text: v.toLowerCase() };
  if (host.startsWith('*.')) return { kind: 'wildcard', suffix: host.slice(2), path };
  if (host.includes('*')) {
    // Inner wildcards like "api-*.example.com" become a label pattern.
    const re = new RegExp(`^${host.split('*').map(escapeRe).join('[a-z0-9-]*')}$`);
    return { kind: 'glob', re, labels: host.split('.').length, path };
  }
  return { kind: 'host', host, path };
}

function matchPattern(p, t) {
  if (p.kind === 'exact') {
    return t.text && t.text === p.text ? { kind: 'exact', score: 1000 } : null;
  }
  if (p.kind === 'cidr') {
    if (t.cidr) {
      const [base, bits] = t.cidr;
      return bits >= p.cidr[1] && inRange(base, p.cidr) ? { kind: 'cidr', score: 100 + p.cidr[1] } : null;
    }
    return t.ip != null && inRange(t.ip, p.cidr) ? { kind: p.cidr[1] === 32 ? 'ip' : 'cidr', score: 100 + p.cidr[1] } : null;
  }
  if (!t.host) return null;
  let hostMatch = null;
  if (p.kind === 'host' && t.host === p.host) hostMatch = { kind: 'host', score: 500 };
  if (p.kind === 'wildcard' && t.host.endsWith(`.${p.suffix}`)) hostMatch = { kind: 'wildcard', score: 200 + p.suffix.split('.').length };
  if (p.kind === 'glob' && p.re.test(t.host)) hostMatch = { kind: 'wildcard', score: 300 + p.labels };
  if (!hostMatch) return null;
  if (!p.path) return hostMatch;
  if (t.path.toLowerCase().startsWith(p.path.toLowerCase())) return { kind: 'url', score: hostMatch.score + 50 + p.path.length };
  return { ...hostMatch, score: hostMatch.score - 1, note: `The listed asset only covers paths under ${p.path}.` };
}

function parseIp(s) {
  const m = String(s).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function parseCidr(s) {
  const m = String(s).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) return null;
  const ip = parseIp(m[1]);
  const bits = Number(m[2]);
  if (ip == null || bits > 32) return null;
  return [ip, bits];
}

function inRange(ip, [base, bits]) {
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return ((ip & mask) >>> 0) === ((base & mask) >>> 0);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
