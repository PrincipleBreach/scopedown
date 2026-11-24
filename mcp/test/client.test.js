// Which connected browser answers when the agent does not name one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/client.js';

test('the default browser stays the same when the browsers restart in another order', async () => {
  const bridge = new Bridge();
  const chrome = { path: '/s/host-100.sock', extension: { browser: 'Chrome', install: 'bbb222' } };
  const brave = { path: '/s/host-99.sock', extension: { browser: 'Brave', install: 'aaa111' } };
  bridge.browsers = async () => [chrome, brave];
  assert.equal((await bridge.pick()).extension.browser, 'Brave');
  // Brave restarted, so its host now has a socket name that sorts last.
  bridge.browsers = async () => [chrome, { ...brave, path: '/s/host-200.sock' }];
  assert.equal((await bridge.pick()).extension.browser, 'Brave');
  assert.equal((await bridge.pick('chrome')).extension.browser, 'Chrome');
});
