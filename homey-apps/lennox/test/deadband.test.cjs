'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SessionManager } = require('../lib/session');
const { ManagedS30API } = require('../lib/transport');
const { createEmulator } = require('./emulator.cjs');

const SERIAL = 'EMU-S40-001';
const GAP_PARAMETER = { value: '3', enabled: true, equipType: 7, descriptor: 'range', unit: 'F', range: { min: '3', max: '9', inc: '1' } };
const writes = emulator => emulator.events.filter(event => event.route === 'publish');
const parameter = emulator => emulator.state.equipments[0].equipment.parameters.find(item => item.parameter.pid === 104).parameter;

async function rig(options = {}) {
  const emulator = await createEmulator({ parameter104: GAP_PARAMETER, ...options });
  const apis = [];
  const manager = new SessionManager({ pollMs: 2, drainMs: 2, catalogSettleMs: 10,
    connectTimeoutMs: 1000, confirmTimeoutMs: 80, refreshMs: 100000,
    clientFactory: () => {
      const api = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 300 });
      apis.push(api);
      return api;
    } });
  return { emulator, manager, apis,
    command: (value, readOnly = false, serial = SERIAL, zoneId = 0) => manager.command(emulator.host, serial, zoneId, { type: 'deadband', value }, readOnly),
    async close() { await manager.close(); await emulator.close(); } };
}

test('reported gap metadata is read-only during pairing and a confirmed controller-wide change uses the exact parameter envelope', async () => {
  const context = await rig();
  const { emulator, manager } = context;
  try {
    const devices = await manager.inspect(emulator.host);
    assert.ok(devices.every(device => device.changeoverGap === 3));
    assert.equal(writes(emulator).length, 0, 'Pairing and reported-setting synchronization must never write a default');
    const originalZones = structuredClone(emulator.state.zones);
    const originalSystem = structuredClone(emulator.state.system);
    await context.command(4);
    assert.equal(parameter(emulator).value, '4');
    assert.deepEqual(emulator.state.zones, originalZones, 'A global parameter write must not adjust any zone target or schedule');
    assert.deepEqual(emulator.state.system, originalSystem);
    const commands = writes(emulator);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].data.AdditionalParameters, '/systemControl');
    assert.deepEqual(commands[0].data.Data, { systemControl: { parameterUpdate: { et: 7, pid: 104, value: '4' } } });
    const refreshed = await manager.inspect(emulator.host);
    assert.ok(refreshed.every(device => device.changeoverGap === 4));
    assert.equal(writes(emulator).length, 1, 'Reopening after readback must not repeat the write');
  } finally { await context.close(); }
});

test('gap changes require explicit write permission, valid integer range and matching paired identity', async () => {
  const context = await rig();
  try {
    await assert.rejects(context.command(4, true), /Read-only/);
    assert.equal(context.emulator.events.length, 0, 'Read-only rejection must happen before connecting');
    for (const value of [2, 10, 3.5, '4', NaN, null]) await assert.rejects(context.command(value));
    await assert.rejects(context.command(4, false, 'OTHER-CONTROLLER'), /identity/);
    await assert.rejects(context.command(4, false, SERIAL, 99), /zone/);
    assert.equal(writes(context.emulator).length, 0);
    assert.equal(parameter(context.emulator).value, '3');
  } finally { await context.close(); }
});

test('a gap parameter must explicitly report editable permission and its actual equipment type', async () => {
  for (const metadata of [
    { ...GAP_PARAMETER, enabled: false },
    { ...GAP_PARAMETER, enabled: undefined },
    { ...GAP_PARAMETER, enabled: 'true' },
    { ...GAP_PARAMETER, equipType: undefined },
    { ...GAP_PARAMETER, value: 'invalid' },
  ]) {
    const context = await rig({ parameter104: metadata });
    try {
      await assert.rejects(context.command(4));
      assert.equal(writes(context.emulator).length, 0);
    } finally { await context.close(); }
  }
});

test('editable gap writes honor the actual reported parameter descriptor, Fahrenheit unit, range and increment', async () => {
  for (const metadata of [
    { ...GAP_PARAMETER, descriptor: undefined }, { ...GAP_PARAMETER, descriptor: 'radio' },
    { ...GAP_PARAMETER, unit: 'C' }, { ...GAP_PARAMETER, unit: 'unknown' },
    { ...GAP_PARAMETER, range: undefined }, { ...GAP_PARAMETER, range: {} },
    { ...GAP_PARAMETER, range: { min: 'bad', max: '9', inc: '1' } },
    { ...GAP_PARAMETER, range: { min: '9', max: '3', inc: '1' } },
    { ...GAP_PARAMETER, range: { min: '3', max: '9', inc: '0' } },
  ]) {
    const context = await rig({ parameter104: metadata });
    try {
      await assert.rejects(context.command(4));
      assert.equal(writes(context.emulator).length, 0, 'Incomplete or unsupported parameter metadata must not authorize a command');
    } finally { await context.close(); }
  }
  const context = await rig({ parameter104: { ...GAP_PARAMETER, value: '4', range: { min: '4', max: '8', inc: '2' } } });
  try {
    for (const value of [3, 5, 9]) await assert.rejects(context.command(value));
    assert.equal(writes(context.emulator).length, 0);
    await context.command(6);
    assert.equal(parameter(context.emulator).value, '6');
    assert.equal(writes(context.emulator).length, 1);
  } finally { await context.close(); }
});

test('every active Automatic zone is checked against a proposed global gap and independent modes retain their targets', async () => {
  for (const mode of ['heat and cool', 'heat', 'cool', 'off']) {
    const context = await rig();
    try {
      Object.assign(context.emulator.state.zones[1].status.period, { systemMode: mode, hsp: 72, hspC: 22, csp: 76, cspC: 24.5 });
      const original = structuredClone(context.emulator.state.zones);
      if (mode === 'heat and cool') {
        await assert.rejects(context.command(5), /zone|separat|gap|Automatic/i);
        assert.equal(writes(context.emulator).length, 0, 'A different zone must be able to block the controller-wide change');
      } else {
        await context.command(5);
        assert.equal(writes(context.emulator).length, 1);
      }
      assert.deepEqual(context.emulator.state.zones, original);
    } finally { await context.close(); }
  }
});

test('unknown active zone state blocks a global gap edit while disabled zones do not constrain it', async () => {
  for (const central of [false, true]) {
    const context = await rig({ central });
    try {
      Object.assign(context.emulator.state.zones[1].status.period, { systemMode: 'unknown-mode', hsp: null, hspC: null, csp: null, cspC: null });
      if (central) {
        await context.command(4);
        assert.equal(writes(context.emulator).length, 1);
      } else {
        await assert.rejects(context.command(4), /active zone|operating mode/i);
        assert.equal(writes(context.emulator).length, 0);
      }
    } finally { await context.close(); }
  }
});

test('queued controller gap edits confirm each actual report at both supported endpoints without changing zone targets', async () => {
  const context = await rig();
  try {
    const zones = structuredClone(context.emulator.state.zones);
    await Promise.all([9, 3].map(value => context.command(value)));
    assert.deepEqual(writes(context.emulator).map(event => event.data.Data.systemControl.parameterUpdate.value), ['9', '3']);
    assert.equal(parameter(context.emulator).value, '3');
    assert.deepEqual(context.emulator.state.zones, zones);
  } finally { await context.close(); }
});

test('gap preflight requires fresh parameter data and fresh complete periods for every active zone', async () => {
  for (const missing of ['parameter', 'other-zone']) {
    const context = await rig();
    let remove;
    try {
      let ready;
      const connected = new Promise(resolve => { ready = resolve; });
      remove = context.manager.attach(context.emulator.host, SERIAL, 0, ready, () => {});
      await connected;
      const snapshot = missing === 'parameter'
        ? { zones: structuredClone(context.emulator.state.zones) }
        : { equipments: structuredClone(context.emulator.state.equipments), zones: [structuredClone(context.emulator.state.zones[0])] };
      context.emulator.setBehavior('requestData', { snapshot });
      await assert.rejects(context.command(4), /fresh|parameter|zone|response/i);
      assert.equal(writes(context.emulator).length, 0, `Cached ${missing} data must not authorize a global write`);
    } finally { await remove?.(); await context.close(); }
  }
});

test('HTTP success alone cannot authorize a parameter change and a rejected acknowledgement can be retried', async () => {
  const context = await rig();
  try {
    for (const response of [
      { status: 204 }, { status: 500 }, { status: 200, body: { code: 0 } },
      { status: 200, body: {} }, { status: 200, body: { code: '1' } }, { status: 200, body: 'invalid-json' },
    ]) {
      context.emulator.setBehavior('publish', response);
      await assert.rejects(context.command(4));
      assert.equal(parameter(context.emulator).value, '3');
    }
    context.emulator.setBehavior('publish', null);
    await context.command(4);
    assert.equal(parameter(context.emulator).value, '4');
    assert.equal(writes(context.emulator).length, 7);
  } finally { await context.close(); }
});

test('an acknowledged parameter write needs a new matching parameter report, not fresh zone periods alone', async () => {
  for (const options of [{ ignoreParameterCommands: true }, { omitParameterReadback: true }]) {
    const context = await rig(options);
    try {
      await assert.rejects(context.command(4), /confirm|fresh|parameter|response/i);
      assert.equal(writes(context.emulator).length, 1);
      assert.equal(parameter(context.emulator).value, options.ignoreParameterCommands ? '3' : '4');
      assert.ok(context.emulator.events.some(event => event.route === 'retrieve'));
    } finally { await context.close(); }
  }
});
