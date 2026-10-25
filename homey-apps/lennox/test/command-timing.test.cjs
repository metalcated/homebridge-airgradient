'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SessionManager } = require('../lib/session');
const { ManagedS30API } = require('../lib/transport');
const { createEmulator } = require('./emulator.cjs');

const SERIAL = 'EMU-S40-001';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const publishes = emulator => emulator.events.filter(event => event.route === 'publish');
const timeout = error => error.code === 'LENNOX_COMMAND_TIMEOUT' && /final state could not be confirmed/.test(error.message);

async function rig(options = {}, emulatorOptions = {}) {
  const emulator = await createEmulator(emulatorOptions);
  const logs = [];
  const manager = new SessionManager({ pollMs: 15, drainMs: 1, catalogSettleMs: 0,
    connectTimeoutMs: 500, confirmTimeoutMs: 300, commandTimeoutMs: 500,
    clientFactory: () => new ManagedS30API({ host: emulator.host, port: emulator.port,
      protocol: emulator.protocol, requestTimeoutMs: 250 }),
    log: (message, detail) => logs.push({ message, detail }), ...options });
  // Retain the same connection without background polling. Every command still
  // uses the real HTTP transport, pinned parser, manager queue, and readback.
  const session = manager.get(emulator.host);
  session.holds++;
  await session.exclusive(() => session.connect());
  return { emulator, manager, session, logs,
    command: command => manager.command(emulator.host, SERIAL, 0, command, false),
    async close() { await manager.close(); await emulator.close(); } };
}

for (const type of ['heat', 'deadband']) {
  test(`queued protocol fragments are drained within the UI deadline for a ${type} command`, async () => {
    const fixture = await rig({ pollMs: 1000, drainMs: 25, confirmTimeoutMs: 10000, commandTimeoutMs: 40000 },
      { parameter104: { value: '3', enabled: true, equipType: 7,
        descriptor: 'range', unit: 'F', range: { min: '3', max: '9', inc: '1' } } });
    const { emulator, session, logs } = fixture;
    try {
      const request = session.api.requestDataHelper.bind(session.api);
      session.api.requestDataHelper = (...args) => {
        // Retrieve serves ten notifications at a time. Fourteen unrelated
        // responses before each fresh snapshot used to cost fourteen seconds.
        for (let count = 0; count < 140; count++) emulator.enqueue({});
        return request(...args);
      };
      const method = type === 'deadband' ? 'publishTemperatureDeadband' : 'publishMessage';
      const publish = session.api[method].bind(session.api);
      session.api[method] = (...args) => {
        for (let count = 0; count < 140; count++) emulator.enqueue({});
        return publish(...args);
      };
      const previousCool = emulator.state.zones[0].status.period.cspC;
      const started = Date.now();
      await fixture.command({ type, value: type === 'heat' ? 21 : 4 });
      assert.ok(Date.now() - started < 8000, 'Both refresh and confirmation must drain queued data before ten seconds');
      assert.equal(publishes(emulator).length, 1, 'Confirmation must never republish the command');
      assert.ok(emulator.events.filter(event => event.route === 'retrieve').length >= 28);
      assert.equal(emulator.state.zones[0].status.period.cspC, previousCool);
      const timing = logs.find(entry => entry.message === 'Lennox command timing').detail;
      assert.equal(timing.outcome, 'confirmed');
      assert.ok(timing.refreshMs >= 250 && timing.confirmMs >= 250);
      assert.deepEqual(Object.keys(timing).sort(),
        ['operation', 'outcome', 'phase', 'elapsedMs', 'queueMs', 'connectMs', 'refreshMs', 'publishMs', 'confirmMs'].sort());
      assert.ok(!JSON.stringify(timing).includes(SERIAL));
    } finally { await fixture.close(); }
  });
}

test('a command expires while queued and cannot publish later; the next explicit command recovers', async () => {
  const fixture = await rig({ commandTimeoutMs: 80 });
  const { manager, session, emulator, logs } = fixture;
  let unblock;
  const blocked = session.exclusive(() => new Promise(resolve => { unblock = resolve; }));
  try {
    const count = emulator.events.length;
    const started = Date.now();
    await assert.rejects(fixture.command({ type: 'heat', value: 21 }), timeout);
    assert.ok(Date.now() - started < 250, 'The caller deadline includes queue wait');
    assert.equal(publishes(emulator).length, 0);
    assert.equal(session.holds, 2, 'The expired command retains its hold until serialized work settles');
    assert.equal(logs.at(-1).detail.phase, 'queued');
    unblock(); await blocked; await session.queue; await sleep(0);
    assert.equal(emulator.events.length, count, 'An expired queued command cannot start a protocol phase');
    assert.equal(session.holds, 1);
    assert.equal(manager.sessions.get(emulator.host), session);
    await fixture.command({ type: 'heat', value: 21 });
    assert.equal(publishes(emulator).length, 1);
    assert.equal(logs.filter(entry => entry.message === 'Lennox command timing').length, 2);
  } finally { unblock?.(); await fixture.close(); }
});

test('a cold connection consumes the same command budget and cannot subscribe or publish after expiry', async () => {
  const emulator = await createEmulator();
  const manager = new SessionManager({ commandTimeoutMs: 80, catalogSettleMs: 0,
    pollMs: 5, connectTimeoutMs: 500, confirmTimeoutMs: 300,
    clientFactory: () => new ManagedS30API({ host: emulator.host, port: emulator.port,
      protocol: emulator.protocol, requestTimeoutMs: 250 }) });
  try {
    emulator.setBehavior('connect', { delayMs: 150 });
    const command = manager.command(emulator.host, SERIAL, 0, { type: 'heat', value: 21 }, false);
    const session = manager.sessions.get(emulator.host);
    await assert.rejects(command, timeout);
    await session.queue; await sleep(0);
    assert.deepEqual(emulator.events.map(event => event.route), ['connect']);
    assert.equal(session.holds, 0);
    assert.equal(session.api.closed, true);
    emulator.setBehavior('connect', null);
    await manager.command(emulator.host, SERIAL, 0, { type: 'heat', value: 21 }, false);
    assert.equal(publishes(emulator).length, 1);
  } finally { await manager.close(); await emulator.close(); }
});

test('the command deadline bounds a pending refresh without releasing the queue or publishing after expiry', async () => {
  const fixture = await rig({ commandTimeoutMs: 80 });
  const { emulator, session } = fixture;
  try {
    emulator.setBehavior('requestData', { hang: true });
    const started = Date.now();
    await assert.rejects(fixture.command({ type: 'heat', value: 21 }), timeout);
    assert.ok(Date.now() - started < 220);
    assert.equal(session.api.requests.size, 1, 'The command must not close the shared connection');
    assert.equal(session.holds, 2);
    assert.equal(publishes(emulator).length, 0);
    emulator.setBehavior('requestData', null);
    await session.queue; await sleep(0);
    assert.equal(session.api.requests.size, 0);
    assert.equal(publishes(emulator).length, 0, 'Settling an expired refresh cannot advance to publication');
    assert.equal(session.holds, 1);
    await fixture.command({ type: 'heat', value: 21 });
    assert.equal(publishes(emulator).length, 1);
  } finally { await fixture.close(); }
});

test('one deadline covers refresh plus publish and a late ACK cannot become success or trigger a republish', async () => {
  const fixture = await rig({ commandTimeoutMs: 130 });
  const { emulator, session, logs } = fixture;
  try {
    emulator.setBehavior('requestData', { delayMs: 75 });
    emulator.setBehavior('publish', { delayMs: 90 });
    const started = Date.now();
    await assert.rejects(fixture.command({ type: 'heat', value: 21 }), timeout);
    assert.ok(Date.now() - started < 260);
    assert.equal(publishes(emulator).length, 1);
    assert.equal(logs.at(-1).detail.phase, 'publish');
    emulator.setBehavior('requestData', null);
    emulator.setBehavior('publish', null);
    await session.queue; await sleep(0);
    // An already transmitted command can apply after the caller deadline.
    // It remains an unconfirmed result and is never automatically retried.
    assert.equal(emulator.state.zones[0].status.period.hspC, 21);
    assert.equal(publishes(emulator).length, 1);
    assert.equal(logs.filter(entry => entry.message === 'Lennox command timing').length, 1);
    await fixture.command({ type: 'heat', value: 21.5 });
    assert.equal(publishes(emulator).length, 2);
    assert.equal(emulator.state.zones[0].status.period.hspC, 21.5);
  } finally { await fixture.close(); }
});

test('an ACK without timely readback expires once, keeps serialization, and permits an explicit retry', async () => {
  const fixture = await rig({ commandTimeoutMs: 80 });
  const { emulator, session, logs } = fixture;
  try {
    const publish = session.api.publishMessage.bind(session.api);
    let blockReadback = true;
    session.api.publishMessage = async (...args) => {
      await publish(...args);
      if (blockReadback) { emulator.setBehavior('requestData', { hang: true }); blockReadback = false; }
    };
    await assert.rejects(fixture.command({ type: 'heat', value: 21 }), timeout);
    assert.equal(publishes(emulator).length, 1);
    assert.equal(logs.at(-1).detail.phase, 'confirm');
    assert.equal(session.api.requests.size, 1);
    emulator.setBehavior('requestData', null);
    await session.queue; await sleep(0);
    assert.equal(publishes(emulator).length, 1);
    await fixture.command({ type: 'heat', value: 21.5 });
    assert.equal(publishes(emulator).length, 2);
    assert.equal(logs.at(-1).detail.outcome, 'confirmed');
  } finally { await fixture.close(); }
});
