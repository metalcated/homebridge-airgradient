'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ManagedS30API } = require('../lib/transport');
const { SessionManager } = require('../lib/session');
const { createEmulator } = require('./emulator.cjs');

const cases = [
  { type: 'heat', value: 23.5, expected: { hsp: 74, hspC: 23.5, csp: 77, cspC: 25 }, companion: 'csp' },
  { type: 'cool', value: 24, expected: { csp: 75, cspC: 24, hsp: 72, hspC: 22 }, companion: 'hsp' },
];

async function rig(item, ignored) {
  const emulator = await createEmulator({ period: { systemMode: item.type, hsp: 73, hspC: 23, csp: 76, cspC: 24.5 },
    parameter104: { value: '3', enabled: true, equipType: 7, descriptor: 'range', unit: 'F', range: { min: '3', max: '9', inc: '1' } } });
  const api = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 300 });
  const before = structuredClone(emulator.state);
  if (ignored) {
    const publish = api.publishMessage.bind(api);
    api.publishMessage = async (...args) => {
      await publish(...args);
      for (const key of [ignored, ignored + 'C']) emulator.state.zones[0].status.period[key] = before.zones[0].status.period[key];
      for (const session of emulator.sessions.values()) session.queue.length = 0;
      emulator.enqueue();
    };
  }
  const logs = [];
  const manager = new SessionManager({ clientFactory: () => api, pollMs: 2, drainMs: 1, catalogSettleMs: 5,
    connectTimeoutMs: 500, confirmTimeoutMs: 60, commandTimeoutMs: 500,
    log: (message, detail) => logs.push({ message, detail }) });
  return { emulator, manager, before, logs,
    command: () => manager.command(emulator.host, 'EMU-S40-001', 0, { type: item.type, value: item.value, units: 'imperial' }, false),
    async close() { await manager.close(); await emulator.close(); } };
}

for (const item of cases) {
  test(`native ${item.type} adjustment shifts its inactive target only when needed and confirms both changed pairs`, async () => {
    const context = await rig(item);
    try {
      const state = await context.command();
      const commands = context.emulator.events.filter(event => event.route === 'publish');
      assert.equal(commands.length, 1);
      assert.deepEqual(commands[0].data.Data, { schedules: [{ id: 16, schedule: { periods: [{ id: 0, period: item.expected }] } }] });
      assert.deepEqual(context.emulator.state.zones[0].status.period, { ...context.before.zones[0].status.period, ...item.expected });
      assert.deepEqual(context.emulator.state.zones[1], context.before.zones[1]);
      assert.deepEqual(context.emulator.state.system, context.before.system);
      assert.equal(state.heat_target, item.expected.hspC);
      assert.equal(state.cool_target, item.expected.cspC);
      const traces = context.logs.filter(entry => entry.message === 'Lennox temperature readback');
      assert.equal(traces.length, 2);
      assert.ok(traces.every(entry => entry.detail.outcome === 'confirmed'));
      assert.deepEqual(traces.map(entry => entry.detail.target).sort(), ['cool', 'heat']);
    } finally { await context.close(); }
  });

  for (const ignored of [item.companion, item.type === 'heat' ? 'hsp' : 'csp']) {
    test(`a ${item.type} request cannot succeed when the thermostat leaves its ${ignored} pair unchanged`, async () => {
      const context = await rig(item, ignored);
      try {
        await assert.rejects(context.command(), /did not confirm/);
        assert.equal(context.emulator.events.filter(event => event.route === 'publish').length, 1);
        const traces = context.logs.filter(entry => entry.message === 'Lennox temperature readback');
        assert.equal(traces.length, 2);
        assert.ok(traces.every(entry => entry.detail.outcome === 'unconfirmed'));
      } finally { await context.close(); }
    });
  }
}
