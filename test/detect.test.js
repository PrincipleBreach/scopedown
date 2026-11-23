import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/platforms/index.js';

const cases = [
  ['https://hackerone.com/security', 'hackerone', { handle: 'security' }],
  ['https://hackerone.com/security/policy_scopes?type=team', 'hackerone', { handle: 'security' }],
  ['https://hackerone.com/github?type=team#scope', 'hackerone', { handle: 'github' }],
  ['https://hackerone.com/hacktivity/overview', null],
  ['https://hackerone.com/', null],
  ['https://bugcrowd.com/engagements/tesla', 'bugcrowd', { code: 'tesla' }],
  ['https://bugcrowd.com/engagements/okta/announcements', 'bugcrowd', { code: 'okta' }],
  ['https://bugcrowd.com/tesla', 'bugcrowd', { code: 'tesla' }],
  ['https://bugcrowd.com/engagements', null],
  ['https://bugcrowd.com/dashboard', null],
  ['http://hackerone.com/security', null],
  ['https://evil.com/hackerone.com/security', null],
  ['https://hackerone.com.evil.com/security', null],
  ['chrome://extensions', null],
  ['not a url', null],
];

for (const [url, id, target] of cases) {
  test(`detect ${url}`, () => {
    const hit = detect(url);
    assert.equal(hit?.id ?? null, id);
    if (target) assert.deepEqual(hit.target, target);
  });
}
