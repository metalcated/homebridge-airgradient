'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyInstalled, validateInstallUrl, configureRoute } = require('../scripts/install-app.cjs');

test('installation waits for the expected app version to be running', async () => {
  let calls = 0, clock = 0;
  const result = await verifyInstalled({ version: '0.1.0', now: () => clock,
    sleep: async ms => { clock += ms; }, getApp: async () => ({ id: 'com.metalcated.lennox',
      version: '0.1.0', state: ++calls === 1 ? 'starting' : 'running', enabled: true }) });
  assert.equal(result.state, 'running'); assert.equal(calls, 2);
});

test('old, disabled, missing and crashed app states cannot pass installation verification', async () => {
  for (const app of [{ version: '0.0.9', state: 'running' }, { version: '0.1.0', enabled: false },
    { version: '0.1.0', state: 'crashed', crashedMessage: 'Test failure' }]) {
    await assert.rejects(verifyInstalled({ version: '0.1.0', getApp: async () => app }));
  }
  await assert.rejects(verifyInstalled({ version: '0.1.0', getApp: async () => { throw Error('Not found'); } }), /Not found/);
});

test('an app that never starts fails with a bounded wait', async () => {
  let clock = 0;
  await assert.rejects(verifyInstalled({ version: '0.1.0', timeoutMs: 2000, now: () => clock,
    sleep: async ms => { clock += ms; }, getApp: async () => ({ version: '0.1.0', state: 'starting' }) }), /did not report it running/);
});

test('installation route overrides accept only credential-free local tunnel addresses', () => {
  assert.equal(validateInstallUrl('http://host.docker.internal:14859'), 'http://host.docker.internal:14859');
  assert.equal(validateInstallUrl('http://127.0.0.1:14859'), 'http://127.0.0.1:14859');
  for (const value of ['http://example.com', 'http://user:password@localhost:4859', 'http://localhost/path',
    'http://localhost/?token=secret', 'http://localhost/#fragment', 'ftp://localhost']) assert.throws(() => validateInstallUrl(value));
});

test('a tunnel is used only after its identity and existing authenticated session are verified', async () => {
  let sessionChecks = 0;
  const homey = { id: 'selected-homey', sessions: { async getSessionMe(options) {
    assert.deepEqual(options, { $cache: false, $socket: false }); sessionChecks++;
  } } };
  await configureRoute(homey, 'http://localhost:14859', async (url, options) => {
    assert(url.endsWith('/ping?id=selected-homey'));
    assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-Homey-ID'], homey.id);
    assert.equal(options.headers.Authorization, undefined);
    return { ok: true, headers: new Headers({ 'x-homey-id': homey.id }), text: async () => 'true' };
  });
  assert.equal(await homey.__baseUrlPromise, 'http://localhost:14859'); assert.equal(sessionChecks, 1);
});

test('a different Homey or rejected ping never receives the authenticated installation', async () => {
  for (const response of [{ ok: true, id: 'different-homey', body: 'true' }, { ok: false, id: 'selected-homey', body: 'false' },
    { ok: true, id: 'selected-homey', body: 'false' }]) {
    const homey = { id: 'selected-homey', sessions: { getSessionMe() { assert.fail('Authentication must not be sent'); } } };
    await assert.rejects(configureRoute(homey, 'http://localhost:14859', async () => ({ ok: response.ok,
      headers: new Headers({ 'x-homey-id': response.id }), text: async () => response.body })), /does not lead/);
    assert.equal(homey.__baseUrlPromise, undefined);
  }
});
