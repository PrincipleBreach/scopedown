// Labeled cases for the scope checker, built from real program scope in test/fixtures.
// Each label was decided by reading the program's own asset list, not the checker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtures } from './helpers.js';
import { checkScope } from '../src/agent/scope.js';

const programs = Object.fromEntries(fixtures().map((f) => [f.file.replace('.json', ''), f.program.scopes]));

const CASES = [
  // HackerOne's own program: hosts, URLs with paths, wildcards written as URLs, out-of-scope hosts.
  ['hackerone-security', 'hackerone.com', 'in_scope'],
  ['hackerone-security', 'https://hackerone.com/reports/123', 'in_scope'],
  ['hackerone-security', 'api.hackerone.com', 'in_scope'],
  ['hackerone-security', 'https://api.hackerone.com:443/v1/me', 'in_scope'],
  ['hackerone-security', 'support.hackerone.com', 'out_of_scope'],
  ['hackerone-security', 'https://go.hacker.one/x', 'out_of_scope'],
  ['hackerone-security', 'x.hackerone-user-content.com', 'in_scope'],
  ['hackerone-security', 'hackerone-user-content.com', 'in_scope'],
  ['hackerone-security', 'a5s.hackerone-ext-content.com', 'in_scope'],
  ['hackerone-security', 'anything.vpn.hackerone.net', 'in_scope'],
  ['hackerone-security', 'vpn.hackerone.net', 'not_listed'],
  ['hackerone-security', 'docs.hackerone.com', 'not_listed'],
  ['hackerone-security', 'hackerone.com.evil.com', 'not_listed'],
  ['hackerone-security', 'evilhackerone.com', 'not_listed'],
  ['hackerone-security', 'https://hackerone.com/mcp', 'in_scope'],
  ['hackerone-security', 'not a host', 'not_listed'],
  // Shopify: broad wildcards with specific exclusions.
  ['hackerone-shopify', 'admin.shopify.com', 'in_scope'],
  ['hackerone-shopify', 'deep.sub.shopify.io', 'in_scope'],
  // GitLab: wildcard plus out-of-scope hosts under it.
  ['hackerone-gitlab', 'gitlab.com', 'in_scope'],
  // Bugcrowd Tesla: wildcard targets and out-of-scope groups.
  ['bugcrowd-tesla', 'shop.tesla.cn', 'in_scope'],
  ['bugcrowd-tesla', 'tesla.cn', 'not_listed'],
  // Bugcrowd Zendesk: descriptive names whose real address is a {subdomain} template.
  ['bugcrowd-zendesk', 'https://acme.zendesk.com/agent/tickets/1', 'in_scope'],
  ['bugcrowd-zendesk', 'support.zendesk.com', 'out_of_scope'],
  ['bugcrowd-zendesk', 'www.zendesk.com', 'out_of_scope'],
  ['bugcrowd-zendesk', 'cdn.zdassets.com', 'out_of_scope'],
  ['bugcrowd-zendesk', 'zendesk.com', 'not_listed'],
];

for (const [program, target, want] of CASES) {
  test(`${program}: ${target} is ${want}`, () => {
    assert.ok(programs[program], `fixture ${program}`);
    const r = checkScope(programs[program], target);
    assert.equal(r.verdict, want, JSON.stringify(r));
  });
}

test('specific in-scope host beats a broader out-of-scope wildcard, and the reverse', () => {
  const scopes = [
    { identifier: '*.example.com', inScope: false },
    { identifier: 'api.example.com', inScope: true, bounty: true, maxSeverity: 'critical' },
    { identifier: '*.corp.example.org', inScope: false },
    { identifier: '*.example.org', inScope: true },
  ];
  assert.equal(checkScope(scopes, 'api.example.com').verdict, 'in_scope');
  assert.equal(checkScope(scopes, 'www.example.com').verdict, 'out_of_scope');
  assert.equal(checkScope(scopes, 'vpn.corp.example.org').verdict, 'out_of_scope');
  assert.equal(checkScope(scopes, 'www.example.org').verdict, 'in_scope');
  const r = checkScope(scopes, 'https://api.example.com/x');
  assert.equal(r.bounty, true);
  assert.equal(r.max_severity, 'critical');
});

test('IP addresses and CIDR ranges match by containment', () => {
  const scopes = [
    { identifier: '10.0.0.0/16', inScope: true },
    { identifier: '10.0.5.0/24', inScope: false },
    { identifier: '192.0.2.7', inScope: true },
  ];
  assert.equal(checkScope(scopes, '10.0.1.2').verdict, 'in_scope');
  assert.equal(checkScope(scopes, '10.0.5.9').verdict, 'out_of_scope');
  assert.equal(checkScope(scopes, '10.1.0.1').verdict, 'not_listed');
  assert.equal(checkScope(scopes, '10.0.1.0/24').verdict, 'in_scope');
  assert.equal(checkScope(scopes, '10.0.0.0/8').verdict, 'not_listed', 'a range wider than the asset is not covered');
  assert.equal(checkScope(scopes, 'http://192.0.2.7:8080/').verdict, 'in_scope');
  assert.equal(checkScope(scopes, '192.0.2.8').verdict, 'not_listed');
});

test('URL assets with a path flag targets outside that path', () => {
  const scopes = [{ identifier: 'https://example.com/app', inScope: true }];
  assert.equal(checkScope(scopes, 'https://example.com/app/settings').note, undefined);
  const outside = checkScope(scopes, 'https://example.com/blog');
  assert.equal(outside.verdict, 'in_scope');
  assert.match(outside.note, /only covers paths under \/app/);
});

test('non-web assets match only their exact identifier', () => {
  const scopes = [{ identifier: 'com.example.app', type: 'Android: Play Store', inScope: true }];
  assert.equal(checkScope(scopes, 'com.example.app').verdict, 'in_scope');
  assert.equal(checkScope(scopes, 'evil.example.app').verdict, 'not_listed');
});
