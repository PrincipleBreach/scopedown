// The platform contract. Every adapter in the registry must pass this, so a new platform
// (YesWeHack, Intigriti, ...) plugs in without touching shared code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, detect, AGENT_PERMISSIONS } from '../src/platforms/index.js';
import { fixtures } from './helpers.js';

const REQUIRED_AGENT = ['account', 'program', 'listPrograms', 'weaknesses', 'resolveWeakness', 'requirements', 'myReports', 'findFiled', 'formUrl', 'formFields'];
const OPTIONAL_AGENT = ['myReport', 'disclosed', 'file', 'severityFor', 'prefill', 'watch'];

for (const a of ADAPTERS) {
  test(`${a.id}: implements the adapter contract`, () => {
    assert.match(a.id, /^[a-z0-9-]{2,40}$/);
    assert.equal(typeof a.label, 'string');
    assert.match(a.origin, /^https:\/\/[\w.-]+$/);
    assert.ok(['Weakness', 'VRT'].includes(a.weaknessLabel) || typeof a.weaknessLabel === 'string');
    for (const k of ['match', 'inPageArgs', 'fetchInPage', 'normalize']) assert.equal(typeof a.program[k], 'function', `program.${k}`);
    for (const k of REQUIRED_AGENT) assert.equal(typeof a.agent[k], 'function', `agent.${k}`);
    for (const k of Object.keys(a.agent)) assert.ok([...REQUIRED_AGENT, ...OPTIONAL_AGENT].includes(k), `agent.${k} is not part of the contract`);
    assert.ok(AGENT_PERMISSIONS.origins.includes(`${a.origin}/*`));
  });

  test(`${a.id}: its in-page reader is self-contained`, () => {
    const src = a.program.fetchInPage.toString();
    assert.ok(!/\bimport\b|\brequire\(/.test(src), 'no imports inside the injected function');
  });

  if (a.agent.watch) {
    test(`${a.id}: its scope watch lists, signals and reads`, () => {
      for (const k of ['list', 'signals', 'scopes']) assert.equal(typeof a.agent.watch[k], 'function', `watch.${k}`);
      if (a.agent.watch.due) assert.equal(typeof a.agent.watch.due, 'function');
      if (a.agent.watch.rotate) assert.ok(Number.isInteger(a.agent.watch.rotate) && a.agent.watch.rotate > 0);
    });
  }

  if (a.agent.prefill) {
    test(`${a.id}: its form prefill is an in-page function and an argument builder`, () => {
      assert.equal(typeof a.agent.prefill.func, 'function');
      assert.equal(typeof a.agent.prefill.args, 'function');
      assert.equal(typeof a.agent.prefill.finish, 'string', 'the last step the hunter takes, shown in the console');
      assert.ok(!/\bimport\b|\brequire\(/.test(a.agent.prefill.func.toString()), 'no imports inside the injected function');
      // It must survive being sent to the page on its own.
      assert.doesNotThrow(() => new Function(`return (${a.agent.prefill.func.toString()})`)());
      const args = a.agent.prefill.args({ title: 'T', asset: { identifier: 'a.example', id: 'x' }, weakness: { id: 'w.x', name: 'W' }, description: 'D', impact: 'I', custom_fields: [] }, []);
      assert.ok(Array.isArray(args));
      assert.doesNotThrow(() => structuredClone(args), 'arguments are plain data');
    });
  }

  test(`${a.id}: detects its own program URLs and nothing else`, () => {
    const host = new URL(a.origin).host;
    assert.equal(detect(`https://${host}.evil.example/x`), null);
    assert.equal(detect(`http://${host}/x`), null);
  });

  test(`${a.id}: normalizes real program data into the shared program shape`, () => {
    const mine = fixtures().filter((f) => f.program.platform === a.id);
    assert.ok(mine.length > 0, 'has at least one fixture');
    for (const f of mine) {
      const p = f.program;
      for (const k of ['platform', 'platformName', 'name', 'handle', 'url', 'scopes', 'sections', 'facts', 'groups', 'warnings']) assert.ok(k in p, `${f.file}: ${k}`);
      assert.equal(p.platformName, a.label);
      assert.ok(p.url.startsWith(a.origin));
      for (const s of p.scopes) assert.equal(typeof s.identifier, 'string');
    }
  });

  test(`${a.id}: form fields are label and value pairs`, () => {
    const fields = a.agent.formFields({ title: 'T', asset: { identifier: 'a.example' }, weakness: { id: 'w', name: 'W', priority: 2 }, severity: 'low', description: 'D', impact: 'I', url: 'https://a.example/x', custom_fields: [] });
    assert.ok(fields.length >= 4);
    for (const [k, v] of fields) {
      assert.equal(typeof k, 'string');
      assert.equal(typeof v, 'string');
    }
  });
}

test('registry ids are unique', () => {
  assert.equal(new Set(ADAPTERS.map((a) => a.id)).size, ADAPTERS.length);
});
