'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ManagedS30API } = require('../lib/transport');
const { SessionManager } = require('../lib/session');
const { createEmulator } = require('./emulator.cjs');

async function fixture(t, options = {}) {
  const emulator = await createEmulator(options.emulator);
  const api = new ManagedS30API({
    host: emulator.host,
    port: emulator.port,
    protocol: emulator.protocol,
    requestTimeoutMs: options.requestTimeoutMs ?? 2000,
  });
  t.after(async () => { await api.close(); await emulator.close(); });
  return { api, emulator };
}

async function connect(api) {
  await api.serverConnect();
  const system = api.getSystem('LCC');
  assert.ok(system, 'LAN login creates the LCC system');
  await api.subscribe(system);
  assert.equal(await api.messagePump(), true);
  return system;
}

test('published Lennox client connects, subscribes and parses real protocol messages through managed transport', async t => {
  const { api, emulator } = await fixture(t);
  const system = await connect(api);
  assert.equal(system.name, 'Emulated Lennox');
  assert.equal(system.serialNumber, 'EMU-S40-001');
  assert.equal(system.productType, 'S40');
  assert.equal(system.configComplete(), true);
  assert.equal(system.singleSetpointMode, false);
  assert.equal(system.zones.length, 2);
  const zone = system.getZone(0);
  assert.equal(zone.name, 'Living Room');
  assert.equal(zone.temperatureC, 22);
  assert.equal(zone.temperatureStatus, 'good');
  assert.equal(zone.humidity, 43);
  assert.equal(zone.systemMode, 'heat and cool');
  assert.equal(zone.fanMode, 'auto');
  assert.equal(zone.minHspC, 10);
  assert.equal(zone.maxCspC, 35);
  assert.equal(zone.getManualModeScheduleId(), 16);
  assert.equal(system.getZone(1).isZoneDisabled, false);
  assert.equal(await api.messagePump(), false, '204 retrieve is a normal idle poll');
  const requests = emulator.events.filter(event => event.route === 'requestData');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(event => event.data.TargetID === 'LCC'));
  assert.match(requests[0].data.AdditionalParameters.JSONPath, /\/zones/);
  const retrieve = emulator.events.find(event => event.route === 'retrieve');
  assert.equal(retrieve.query.Direction, 'Oldest-to-Newest');
  assert.equal(retrieve.query.MessageCount, '10');
  assert.equal(emulator.events.some(event => event.data?.Data?.resetLcc), false);
});

test('LAN updates with cloud SenderID reach the existing local system and callbacks', async t => {
  const { api, emulator } = await fixture(t, { emulator: { senderId: 'cloud-system-id' } });
  const system = await connect(api);
  let callbacks = 0;
  system.getZone(0).registerOnUpdateCallback(() => { callbacks++; }, ['temperatureC']);
  emulator.state.zones[0].status.temperatureC = 23.5;
  emulator.enqueue();
  await api.messagePump();
  assert.equal(system.getZone(0).temperatureC, 23.5);
  assert.equal(callbacks, 1);
  assert.equal(api.getSystem('cloud-system-id'), undefined);
});

test('real inherited mode, fan, setpoint, away and schedule commands receive device readback', async t => {
  const { api, emulator } = await fixture(t);
  const system = await connect(api);
  const zone = system.getZone(0);
  await zone.setHVACMode('heat');
  await api.messagePump();
  assert.equal(zone.systemMode, 'heat');
  await zone.setFanMode('circulate');
  await api.messagePump();
  assert.equal(zone.fanMode, 'circulate');
  await zone.performSetpoint({ hspC: 21 });
  await api.messagePump();
  assert.equal(zone.hspC, 21);
  assert.equal(zone.cspC, 25);
  assert.equal(zone.husp, 38);
  assert.equal(zone.desp, 52);
  assert.equal(zone.humidityMode, 'both');
  assert.equal(zone.fanMode, 'circulate');
  assert.equal(emulator.state.zones[0].status.period.vendorExtension, 'keep-this-field');
  assert.equal(emulator.state.system.config.vendorExtension, 'keep-system-config');
  assert.equal(system.getZone(1).hspC, 20, 'zone commands do not change the other zone');
  await system.setManualAwayMode(true);
  await api.messagePump();
  assert.equal(system.manualAwayMode, true);
  await zone.performSetpoint({ hspC: 19 });
  const awayCommand = emulator.events.filter(event => event.route === 'publish').at(-1);
  assert.equal(awayCommand.data.Data.schedules[0].id, 3);
  await api.messagePump();
  await zone.setScheduleHold(true);
  await api.messagePump();
  assert.equal(zone.scheduleHold, true);
  await zone.setSchedule('Weekday');
  await api.messagePump();
  assert.equal(zone.scheduleId, 0);
  await assert.rejects(zone.setHVACMode('invalid-mode'), /Invalid HVAC mode/);
  await assert.rejects(zone.setFanMode('invalid-fan'), /Invalid fan mode/);
});

test('a confirmed cooling command changes only its Celsius/Fahrenheit setpoint and preserves heat, mode, humidity and other zones', async t => {
  const { api, emulator } = await fixture(t);
  const manager = new SessionManager({ clientFactory: () => api, pollMs: 5, drainMs: 5,
    catalogSettleMs: 10, connectTimeoutMs: 1000, confirmTimeoutMs: 200 });
  t.after(() => manager.close());
  const originalPeriod = structuredClone(emulator.state.zones[0].status.period);
  const originalOtherZone = structuredClone(emulator.state.zones[1]);
  const originalSystem = structuredClone(emulator.state.system);
  const state = await manager.command(emulator.host, 'EMU-S40-001', 0, { type: 'cool', value: 24.5 }, false);
  assert.equal(state.cool_target, 24.5);
  assert.equal(state['target_temperature.cool'], 24.5);
  assert.equal(state.heat_target, 20);
  assert.equal(state.thermostat_mode, 'auto');
  const writes = emulator.events.filter(event => event.route === 'publish');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.Data.schedules[0].id, 16);
  assert.deepEqual(writes[0].data.Data.schedules[0].schedule.periods[0].period, { cspC: 24.5, csp: 76 });
  assert.deepEqual(emulator.state.zones[0].status.period, { ...originalPeriod, cspC: 24.5, csp: 76 });
  assert.deepEqual(emulator.state.zones[1], originalOtherZone);
  assert.deepEqual(emulator.state.system, originalSystem);
  assert.equal(emulator.events.some(event => event.data?.Data?.resetLcc), false);
});

test('retained independent controls cannot actuate a single-setpoint or explicitly unsupported direction', async () => {
  for (const scenario of [
    { single: true, type: 'heat', error: /single temperature target/ },
    { single: true, type: 'cool', error: /single temperature target/ },
    { single: false, type: 'cool', disabled: true, error: /not supported/ },
  ]) {
    const emulator = await createEmulator({ singleSetpoint: scenario.single });
    if (scenario.disabled) {
      emulator.state.zones[0].config.coolingOption = false;
      emulator.state.zones[0].status.period.systemMode = 'heat';
    }
    const original = structuredClone(emulator.state);
    const manager = new SessionManager({ pollMs: 5, drainMs: 5, catalogSettleMs: 10,
      connectTimeoutMs: 1000, confirmTimeoutMs: 200,
      clientFactory: () => new ManagedS30API({ host: emulator.host, port: emulator.port,
        protocol: emulator.protocol, requestTimeoutMs: 500 }) });
    try {
      await assert.rejects(manager.command(emulator.host, 'EMU-S40-001', 0,
        { type: scenario.type, value: scenario.type === 'heat' ? 21 : 24 }, false), scenario.error);
      assert.equal(emulator.events.filter(event => event.route === 'publish').length, 0);
      assert.deepEqual(emulator.state, original);
    } finally { await manager.close(); await emulator.close(); }
  }
});

test('single setpoint and central zoning are parsed from equipment and system data', async t => {
  const { api } = await fixture(t, { emulator: { singleSetpoint: true, central: true } });
  const system = await connect(api);
  assert.equal(system.singleSetpointMode, true);
  assert.equal(system.getZone(1).isZoneDisabled, true);
  const zone = system.getZone(0);
  await assert.rejects(zone.performSetpoint({ hspC: 21 }), /single setpoint mode/);
  await zone.performSetpoint({ spC: 22.5 });
  await api.messagePump();
  assert.equal(zone.spC, 22.5);
});

test('managed transport handles Lennox noncompliant response framing locally', async t => {
  const { api } = await fixture(t, { emulator: { ambiguousHeaders: true } });
  const system = await connect(api);
  assert.equal(system.getZone(0).temperatureC, 22);
});

test('request errors propagate and a retry succeeds without a controller reset', async t => {
  const { api, emulator } = await fixture(t);
  emulator.setBehavior('connect', { status: 503, body: 'temporarily unavailable' });
  await assert.rejects(api.serverConnect(), /503/);
  emulator.setBehavior('connect', null);
  const system = await connect(api);
  emulator.setBehavior('retrieve', { status: 500, body: 'read failed' });
  await assert.rejects(api.messagePump(), /500/);
  emulator.setBehavior('retrieve', { status: 200, body: '{invalid json' });
  await assert.rejects(api.messagePump());
  emulator.setBehavior('retrieve', null);
  emulator.setBehavior('publish', { status: 403, body: 'command rejected' });
  await assert.rejects(system.getZone(0).setHVACMode('cool'), /403/);
  assert.equal(system.getZone(0).systemMode, 'heat and cool');
  emulator.setBehavior('publish', null);
  await system.getZone(0).setHVACMode('cool');
  await api.messagePump();
  assert.equal(system.getZone(0).systemMode, 'cool');
  assert.equal(emulator.events.some(event => event.data?.Data?.resetLcc), false);
});

test('hung requests have a bounded timeout and the client can reconnect afterward', async t => {
  const { api, emulator } = await fixture(t, { requestTimeoutMs: 100 });
  emulator.setBehavior('connect', { hang: true });
  const started = Date.now();
  await assert.rejects(api.serverConnect(), /time|abort/i);
  assert.ok(Date.now() - started < 2000, 'request did not wait indefinitely');
  emulator.setBehavior('connect', null);
  assert.ok((await connect(api)).configComplete());
});

test('closing a client aborts an in-flight long poll and is idempotent', async t => {
  const { api, emulator } = await fixture(t);
  await connect(api);
  emulator.setBehavior('retrieve', { hang: true });
  const pending = api.messagePump();
  const rejected = assert.rejects(pending);
  await new Promise(resolve => setTimeout(resolve, 30));
  await api.close();
  await rejected;
  await api.close();
});

test('each local client has a unique connection ID and S30 shutdown disconnects it', async t => {
  const { api, emulator } = await fixture(t, { emulator: { model: 'S30' } });
  const other = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: 'http', requestTimeoutMs: 2000 });
  t.after(() => other.close());
  assert.notEqual(api.getClientId(), other.getClientId());
  await connect(api);
  await api.shutdown();
  assert.equal(emulator.events.filter(event => event.route === 'disconnect').length, 1);
  assert.equal(emulator.sessions.size, 0);
});

test('managed transport rejects URL-shaped hosts and invalid port options before connecting', () => {
  for (const host of ['http://127.0.0.1', '127.0.0.1/path', 'user@localhost', 'localhost?x=1', 'localhost#x', '']) {
    assert.throws(() => new ManagedS30API({ host }), /host|address|invalid/i, host);
  }
  for (const port of [0, -1, 65536, 1.5, '80;exit']) {
    assert.throws(() => new ManagedS30API({ host: '127.0.0.1', port }), /port|invalid/i, String(port));
  }
});

test('requests cannot leave the configured thermostat origin and redirects are not followed', async t => {
  const { api, emulator } = await fixture(t);
  await assert.rejects(api.get('http://example.invalid/'), /endpoint|origin/i);
  await assert.rejects(api.post('https://example.invalid/command', '{}'), /endpoint|origin/i);
  assert.equal(emulator.events.length, 0);
  await connect(api);
  emulator.setBehavior('retrieve', { status: 302, body: 'redirect rejected' });
  await assert.rejects(api.messagePump(), /302/);
  assert.equal(emulator.events.filter(event => event.route === 'unknown').length, 0);
});

test('responses exceeding the bounded size fail and release the active request', async t => {
  const { api, emulator } = await fixture(t);
  await connect(api);
  emulator.setBehavior('retrieve', { status: 200, body: 'x'.repeat(2 * 1024 * 1024 + 1) });
  await assert.rejects(api.messagePump(), /large|interrupt/i);
  assert.equal(api.requests.size, 0);
  emulator.setBehavior('retrieve', null);
  emulator.enqueue();
  assert.equal(await api.messagePump(), true);
});

test('S40 idle polling and shutdown do not send reset or unsupported disconnect commands', async t => {
  const { api, emulator } = await fixture(t);
  await connect(api);
  for (let i = 0; i < 12; i++) assert.equal(await api.messagePump(), false);
  await api.shutdown();
  assert.equal(emulator.events.some(event => event.route === 'publish'), false);
  assert.equal(emulator.events.some(event => event.route === 'disconnect'), false);
});

test('self-signed thermostat HTTPS works without weakening global TLS validation', async t => {
  const https = require('node:https');
  const originalTlsEnvironment = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const { api, emulator } = await fixture(t, { emulator: { tls: true } });
  const system = await connect(api);
  assert.equal(system.serialNumber, 'EMU-S40-001');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, originalTlsEnvironment);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = https.get({ hostname: emulator.host, port: emulator.port, path: '/', agent: false }, response => {
      response.resume();
      response.on('end', resolve);
    });
    request.on('error', reject);
  }), /self.signed|certificate/i);
});

test('numeric and string equipment parameters report the same single setpoint mode', async t => {
  for (const pid of [525, '525']) {
    for (const value of [0, 1, '0', '1']) {
      const { api, emulator } = await fixture(t, { emulator: { noInitialData: true } });
      await api.serverConnect();
      const system = api.getSystem('LCC');
      assert.equal(api.hasSetpointMode, false);
      emulator.enqueue({ equipments: [{ id: 0, equipment: { parameters: [{ id: 1, parameter: { pid, value } }] } }] });
      assert.equal(await api.messagePump(), true);
      assert.equal(api.hasSetpointMode, true, `${typeof pid} PID and ${typeof value} value are recognized`);
      assert.equal(system.singleSetpointMode, value === 1 || value === '1');
    }
  }
});

test('malformed setpoint mode values cannot unlock controls or replace the last reported mode', async t => {
  const { api, emulator } = await fixture(t, { emulator: { noInitialData: true } });
  await api.serverConnect();
  const system = api.getSystem('LCC');
  const report = async parameter => {
    emulator.enqueue({ equipments: [{ id: 0, equipment: { parameters: [{ id: 1, parameter }] } }] });
    await api.messagePump();
  };
  for (const parameter of [{ pid: 524, value: '1' }, { pid: 'invalid', value: '1' }, { value: '1' }]) {
    await report(parameter);
    assert.equal(api.hasSetpointMode, false);
    assert.equal(system.singleSetpointMode, false);
  }
  for (const value of [undefined, null, '', 'unknown', 2, true, false, {}]) {
    await report({ pid: 525, value });
    assert.equal(api.hasSetpointMode, false, `Malformed ${JSON.stringify(value)} must not unlock writes`);
    assert.equal(system.singleSetpointMode, false);
  }
  await report({ pid: '525', value: 1 });
  assert.equal(api.hasSetpointMode, true);
  assert.equal(system.singleSetpointMode, true);
  await report({ pid: 525, value: 'unknown' });
  assert.equal(api.hasSetpointMode, false, 'A later malformed value revokes knowledge of the active mode');
  assert.equal(system.singleSetpointMode, true, 'Invalid data must not overwrite the last observed mode');
  await report({ pid: 525, value: 0 });
  assert.equal(api.hasSetpointMode, true);
  assert.equal(system.singleSetpointMode, false, 'A later valid report restores known mode');
});

test('partial fan reports do not refresh cached temperature or complete operating-period data', async t => {
  const { api, emulator } = await fixture(t);
  const system = await connect(api);
  const initial = { zone: api.zoneRevisions.get(0), temperature: api.temperatureRevisions.get(0), period: api.periodRevisions.get(0) };
  emulator.enqueue({ zones: [{ id: 0, status: { fan: true, period: { fanMode: 'on' } } }] });
  await api.messagePump();
  assert.equal(system.getZone(0).fanMode, 'on', 'Partial status is still applied');
  assert.equal(api.zoneRevisions.get(0), initial.zone + 1);
  assert.equal(api.temperatureRevisions.get(0), initial.temperature, 'An old temperature cannot become fresh from a fan update');
  assert.equal(api.periodRevisions.get(0), initial.period, 'A fan update cannot authorize a command using cached setpoints/mode');

  emulator.enqueue({ zones: [{ id: 0, status: { temperatureC: 23, temperatureStatus: 'good' } }] });
  await api.messagePump();
  assert.equal(api.temperatureRevisions.get(0), initial.temperature + 1);
  assert.equal(api.periodRevisions.get(0), initial.period);

  emulator.enqueue({ zones: [{ id: 0, status: { period: { systemMode: 'heat and cool', fanMode: 'auto', hspC: 20, cspC: 25 } } }] });
  await api.messagePump();
  assert.equal(api.periodRevisions.get(0), initial.period + 1);
  assert.equal(api.temperatureRevisions.get(0), initial.temperature + 1, 'A full period still does not refresh a silent temperature sensor');
  assert.equal(api.temperatureRevisions.get(1), initial.temperature, 'One zone cannot refresh another zone');
});
