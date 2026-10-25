'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SessionManager } = require('../lib/session');
const { ManagedS30API } = require('../lib/transport');
const { createEmulator } = require('./emulator.cjs');

const SERIAL = 'EMU-S40-001';
const HOST = 'thermostat.local';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function eventually(predicate, message, timeoutMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(predicate(), message);
}

function zone(id, overrides = {}) {
  return { id, name: id === 0 ? 'Living Room' : 'Bedroom', temperatureC: 22 + id, humidity: 43,
    temperatureStatus: 'good', humidityStatus: 'good', systemMode: 'heat and cool', tempOperation: 'off', fanMode: 'auto',
    hspC: 20, hsp: 68, cspC: 25, csp: 77, spC: 22, sp: 72,
    heatingOption: true, coolingOption: true, minHspC: 10, maxHspC: 32, minCspC: 15.5, maxCspC: 35,
    isZoneDisabled: false, isZoneActive() { return this.name != null; },
    getManualModeScheduleId() { return 16 + this.id; }, getAwayModeScheduleId() { return 3; }, ...overrides };
}

// This fake uses the pinned Lennox client's public API and delays updates until
// messagePump(), matching the distinction between a command ACK and state data.
class FakeClient {
  constructor(options = {}) {
    this.options = options;
    this.system = { sysId: 'LCC', serialNumber: options.serial ?? SERIAL, name: 'Emulated Lennox',
      singleSetpointMode: false, hspCCspCSeparation: 1.5, manualAwayMode: false, getAwayMode: () => false,
      zones: [zone(0), zone(1), zone(2, { isZoneDisabled: true })] };
    this.hasSetpointMode = options.hasSetpointMode ?? true;
    this.events = [];
    this.pending = [];
    this.zoneRevisions = new Map([[0, 0], [1, 0], [2, 0]]);
    this.revision = 0;
    this.active = 0;
    this.maxActive = 0;
    this.closed = false;
    this.closeCount = 0;
    this.fail = false;
  }

  async operation(name, work) {
    assert.equal(this.closed, false, `${name} cannot use a closed client`);
    this.active++;
    this.maxActive = Math.max(this.active, this.maxActive);
    this.events.push({ name });
    try {
      await tick();
      return await work();
    } finally { this.active--; }
  }

  async serverConnect() { return this.operation('connect', () => {}); }
  getSystem(id) { return id === 'LCC' ? this.system : undefined; }
  async subscribe() {
    return this.operation('subscribe', () => { this.pending.push({ zones: [0, 1, 2] }); });
  }
  async requestDataHelper(sysId, path) {
    return this.operation('request', () => {
      assert.equal(sysId, 'LCC');
      assert.ok(path.includes('/zones'));
      if (this.options.freshResponses !== false) this.pending.push({ zones: this.options.refreshZones ?? [0, 1, 2] });
    });
  }
  async messagePump() {
    return this.operation('poll', async () => {
      if (this.blockNextPoll) {
        const blocked = this.blockNextPoll;
        this.blockNextPoll = null;
        this.blocked = true;
        await blocked;
        this.blocked = false;
      }
      if (this.fail) throw Error('Emulated connection lost');
      const pending = this.pending.shift();
      if (!pending) return false; // The upstream client returns false for HTTP 204.
      pending.apply?.();
      this.revision++;
      for (const id of pending.zones) this.zoneRevisions.set(id, (this.zoneRevisions.get(id) ?? 0) + 1);
      return true;
    });
  }
  async publishMessage(sysId, data) {
    return this.operation('publish', () => {
      assert.equal(sysId, 'LCC');
      this.events.at(-1).data = structuredClone(data);
      if (this.options.rejectWrite) throw Error('Emulated write rejected');
      if (this.options.confirmWrites === false) return;
      const schedule = data.schedules[0];
      const zoneId = schedule.id - 16;
      const target = this.system.zones.find(item => item.id === zoneId);
      assert.ok(target, 'Commands must address one manual zone schedule');
      const period = schedule.schedule.periods[0].period;
      this.pending.push({ zones: [zoneId], apply: () => Object.assign(target, period) });
    });
  }
  async close() {
    this.closeCount++;
    this.closed = true;
  }
}

function setup(options = {}) {
  const clients = [];
  let clock = 1000;
  const manager = new SessionManager({
    pollMs: 5, retryMs: 5, refreshMs: 500, staleMs: 1000, connectTimeoutMs: 30, confirmTimeoutMs: 25,
    now: () => clock,
    sleep: async ms => { clock += ms; await tick(); },
    clientFactory: config => {
      assert.deepEqual(config, { host: HOST });
      const client = new FakeClient(typeof options.clientOptions === 'function'
        ? options.clientOptions(clients.length) : options.clientOptions);
      clients.push(client);
      return client;
    },
    ...options.managerOptions,
  });
  return { manager, clients, advance(ms) { clock += ms; } };
}

function publishes(client) { return client.events.filter(event => event.name === 'publish'); }

test('pairing lists active zones with stable identities and releases the temporary connection', async () => {
  const { manager, clients } = setup();
  try {
    const devices = await manager.inspect(HOST);
    assert.deepEqual(devices.map(device => device.data.id), [`${SERIAL}:0`, `${SERIAL}:1`]);
    assert.ok(devices.every(device => device.settings.read_only === true));
    assert.equal(clients.length, 1);
    assert.equal(clients[0].closed, true);
    assert.equal(manager.sessions.size, 0);
    assert.equal(publishes(clients[0]).length, 0);
  } finally { await manager.close(); }
});

test('pairing waits for split reading/configuration messages before listing zones', async () => {
  let client;
  const { manager } = setup({ managerOptions: { clientFactory: () => {
    client = new FakeClient();
    client.system.serialNumber = null;
    client.system.zones = [zone(0, { heatingOption: undefined, coolingOption: undefined })];
    client.subscribe = async () => client.operation('subscribe', () => {
      client.pending.push({ zones: [0], apply: () => { client.system.serialNumber = SERIAL; } });
      client.pending.push({ zones: [0, 1], apply: () => {
        Object.assign(client.system.zones[0], { heatingOption: true, coolingOption: true });
        client.system.zones.push(zone(1));
      } });
    });
    return client;
  } } });
  try {
    const devices = await manager.inspect(HOST);
    assert.deepEqual(devices.map(device => device.data.id), [`${SERIAL}:0`, `${SERIAL}:1`]);
    assert.ok(devices.every(device => device.capabilities.includes('heat_target') && device.capabilities.includes('cool_target')));
    assert.ok(client.events.filter(event => event.name === 'poll').length >= 3, 'Both data messages must be consumed before the catalog settles');
    assert.equal(client.pending.length, 0);
    assert.equal(client.closed, true);
  } finally { await manager.close(); }
});

test('complete thermostat metadata can finish pairing while unsolicited messages keep every poll nonempty', async () => {
  let client;
  const { manager } = setup({ managerOptions: { connectTimeoutMs: 3000, clientFactory: () => {
    client = new FakeClient();
    client.system.numberOfZones = 2;
    const messagePump = client.messagePump.bind(client);
    client.messagePump = async () => {
      const updated = await messagePump();
      if (!updated) client.revision++;
      // Real controllers can continuously report other system/equipment state;
      // an empty HTTP 204 is not guaranteed after complete zone data arrives.
      return true;
    };
    return client;
  } } });
  try {
    const devices = await manager.inspect(HOST);
    assert.deepEqual(devices.map(device => device.data.id), [`${SERIAL}:0`, `${SERIAL}:1`]);
    assert.ok(devices.every(device => device.capabilities.includes('heat_target') && device.capabilities.includes('cool_target')));
    assert.equal(publishes(client).length, 0);
    assert.equal(client.closed, true);
  } finally { await manager.close(); }
});

test('a late zone extends catalog settling while unrelated traffic continues without idle responses', async () => {
  let client, polls = 0;
  const { manager } = setup({ managerOptions: { connectTimeoutMs: 100, catalogSettleMs: 20, clientFactory: () => {
    client = new FakeClient();
    client.system.zones = [zone(0)];
    const messagePump = client.messagePump.bind(client);
    client.messagePump = async () => {
      await messagePump();
      polls++;
      if (polls === 3) {
        client.system.zones.push(zone(1));
        client.zoneRevisions.set(1, (client.zoneRevisions.get(1) ?? 0) + 1);
      }
      client.revision++;
      return true;
    };
    return client;
  } } });
  try {
    const devices = await manager.inspect(HOST);
    assert.deepEqual(devices.map(device => device.data.id), [`${SERIAL}:0`, `${SERIAL}:1`]);
    assert.ok(polls >= 7, 'The late zone must restart the bounded catalog settling window');
    assert.equal(client.closed, true);
    assert.equal(publishes(client).length, 0);
  } finally { await manager.close(); }
});

test('pairing drains a large initial message backlog before the zone catalog without spending the deadline on idle delays', async () => {
  let client;
  const { manager } = setup({ managerOptions: { pollMs: 1000, connectTimeoutMs: 30000,
    catalogSettleMs: 1000, clientFactory: () => {
      client = new FakeClient();
      client.system.zones = [];
      client.subscribe = async () => client.operation('subscribe', () => {
        // A real subscription can queue many system/equipment fragments before
        // the zone catalog. These successful responses should drain promptly.
        client.pending.push(...Array.from({ length: 70 }, () => ({ zones: [] })));
        client.pending.push({ zones: [0, 1], apply: () => { client.system.zones = [zone(0), zone(1)]; } });
      });
      return client;
    } } });
  try {
    const devices = await manager.inspect(HOST);
    assert.deepEqual(devices.map(device => device.data.id), [`${SERIAL}:0`, `${SERIAL}:1`]);
    assert.equal(client.pending.length, 0);
    assert.ok(client.events.filter(event => event.name === 'poll').length >= 72,
      'The initial fragments, zone catalog, and settling response must be consumed within the deadline');
    assert.equal(publishes(client).length, 0);
    assert.equal(client.closed, true);
  } finally { await manager.close(); }
});

test('closing immediately after subscribing cannot leave a newly created client or background retry alive', async () => {
  const { manager, clients } = setup();
  const states = [], failures = [];
  manager.attach(HOST, SERIAL, 0, state => states.push(state), error => failures.push(error));
  await manager.close();
  await tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(clients.every(client => client.closed), 'Every client created during the race must be closed');
  assert.equal(manager.sessions.size, 0);
  assert.deepEqual(states, []);
  assert.deepEqual(failures, []);
  await assert.rejects(manager.inspect(HOST), /shutting down/);
});

test('zones on one controller share a serialized connection and removal releases only the final subscriber', async () => {
  const { manager, clients } = setup();
  const first = [], second = [], failures = [];
  const removeFirst = manager.attach(HOST, SERIAL, 0, state => first.push(state), error => failures.push(error));
  const removeSecond = manager.attach(HOST, SERIAL, 1, state => second.push(state), error => failures.push(error));
  try {
    await eventually(() => first.length && second.length, 'Both zones should receive a snapshot');
    assert.equal(clients.length, 1);
    assert.equal(first[0].measure_temperature, 22);
    assert.equal(second[0].measure_temperature, 23);
    assert.deepEqual(failures, []);
    await removeFirst();
    assert.equal(clients[0].closed, false);
    const oldCount = second.length;
    await eventually(() => second.length > oldCount, 'Removing one zone must not stop another zone');
    await removeSecond();
    await removeSecond();
    assert.equal(clients[0].closed, true);
    assert.equal(clients[0].closeCount, 1);
    assert.equal(clients[0].maxActive, 1);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.close(); }
});

test('successful empty polls keep the thermostat available without reconnects or controller resets', async () => {
  const { manager, clients } = setup();
  const states = [], failures = [];
  const remove = manager.attach(HOST, SERIAL, 0, state => states.push(state), error => failures.push(error));
  try {
    await eventually(() => states.length >= 4, 'Idle long-polls should continue');
    assert.deepEqual(failures, []);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].closed, false);
    assert.equal(publishes(clients[0]).length, 0);
  } finally { await remove(); await manager.close(); }
});

test('a lost connection marks devices unavailable and recovers automatically with the same paired identity', async () => {
  const { manager, clients } = setup();
  const states = [], failures = [];
  const remove = manager.attach(HOST, SERIAL, 0, state => states.push(state), error => failures.push(error));
  try {
    await eventually(() => states.length > 0, 'Initial connection should succeed');
    clients[0].fail = true;
    await eventually(() => failures.length > 0, 'Connection loss must be visible');
    const oldCount = states.length;
    await eventually(() => clients.length === 2 && states.length > oldCount, 'Retry must restore readings');
    assert.match(failures[0], /connection lost.*retry/i);
    assert.equal(clients[0].closed, true);
    assert.equal(clients[1].closed, false);
    assert.ok(clients.every(client => publishes(client).length === 0));
  } finally { await remove(); await manager.close(); }
});

test('stale snapshots trigger recovery even while the connection returns successful empty responses', async () => {
  const { manager, clients, advance } = setup({ managerOptions: { refreshMs: 100000, staleMs: 30 } });
  const states = [], failures = [];
  const remove = manager.attach(HOST, SERIAL, 0, state => states.push(state), error => failures.push(error));
  try {
    await eventually(() => states.length > 0, 'Initial snapshot should arrive');
    advance(31);
    await eventually(() => failures.length > 0 && clients.length >= 2, 'Stale data must cause a reconnect');
    assert.equal(clients[0].closed, true);
    assert.ok(clients.every(client => publishes(client).length === 0));
  } finally { await remove(); await manager.close(); }
});

test('fresh updates from one zone cannot keep another zone’s old readings available', async () => {
  const { manager, clients, advance } = setup({ managerOptions: { refreshMs: 100000, staleMs: 30 } });
  const first = [], second = [], firstFailures = [], secondFailures = [];
  const removeFirst = manager.attach(HOST, SERIAL, 0, state => first.push(state), error => firstFailures.push(error));
  const removeSecond = manager.attach(HOST, SERIAL, 1, state => second.push(state), error => secondFailures.push(error));
  try {
    await eventually(() => first.length && second.length, 'Both zones should receive their initial readings');
    advance(31);
    clients[0].pending.push({ zones: [1] });
    const previousSecond = second.length;
    await eventually(() => firstFailures.length > 0, 'The silent zone must become unavailable');
    await eventually(() => second.length > previousSecond, 'The reporting zone should continue updating');
    assert.match(firstFailures[0], /stale|unavailable/i);
    assert.deepEqual(secondFailures, []);
  } finally { await removeFirst(); await removeSecond(); await manager.close(); }
});

test('a different serial number or missing zone does not update the wrong paired device', async () => {
  const { manager } = setup();
  const wrongSerialStates = [], missingZoneStates = [], failures = [];
  const removeWrong = manager.attach(HOST, 'OTHER-THERMOSTAT', 0, state => wrongSerialStates.push(state), error => failures.push(error));
  const removeMissing = manager.attach(HOST, SERIAL, 99, state => missingZoneStates.push(state), error => failures.push(error));
  try {
    await eventually(() => failures.length >= 2, 'Invalid paired identities must be unavailable');
    assert.deepEqual(wrongSerialStates, []);
    assert.deepEqual(missingZoneStates, []);
    assert.ok(failures.some(message => /identity/.test(message)));
    assert.ok(failures.some(message => /zone/.test(message)));
  } finally { await removeWrong(); await removeMissing(); await manager.close(); }
});

test('read-only mode rejects all control requests before making a network connection', async () => {
  const { manager, clients } = setup();
  try {
    await assert.rejects(manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }), /Read-only/);
    await assert.rejects(manager.command(HOST, SERIAL, 0, { type: 'mode', value: 'off' }, true), /Read-only/);
    assert.equal(clients.length, 0);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.close(); }
});

test('a control request refreshes state before writing and waits for the reported value before succeeding', async () => {
  const { manager, clients } = setup();
  try {
    const state = await manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }, false);
    assert.equal(state.heat_target, 21);
    const client = clients[0];
    const commands = publishes(client);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0].data.schedules[0].schedule.periods[0].period, { hspC: 21, hsp: 70 });
    assert.equal(client.system.zones[1].hspC, 20, 'Another zone must retain its setpoint');
    const order = client.events.map(event => event.name);
    assert.ok(order.indexOf('request') < order.indexOf('publish'), 'Refresh must precede write');
    assert.ok(order.lastIndexOf('poll') > order.indexOf('publish'), 'State must be read after write');
    assert.equal(client.maxActive, 1);
    assert.equal(client.closed, true);
  } finally { await manager.close(); }
});

test('identity, zone, configuration, mode, and range failures never publish a command', async () => {
  const cases = [
    { serial: 'OTHER-THERMOSTAT', command: { type: 'heat', value: 21 }, message: /identity/ },
    { zoneId: 99, command: { type: 'heat', value: 21 }, message: /zone/ },
    { clientOptions: { hasSetpointMode: false }, command: { type: 'heat', value: 21 }, message: /configuration is incomplete/ },
    { command: { type: 'mode', value: 'emergency heat' }, message: /Unsupported/ },
    { command: { type: 'heat', value: 100 }, message: /limits/ },
  ];
  for (const item of cases) {
    const { manager, clients } = setup({ clientOptions: item.clientOptions });
    try {
      await assert.rejects(manager.command(HOST, item.serial ?? SERIAL, item.zoneId ?? 0, item.command, false), item.message);
      assert.equal(publishes(clients[0]).length, 0);
      assert.equal(clients[0].closed, true);
    } finally { await manager.close(); }
  }
});

test('an acknowledged write without matching readback rejects and preserves the observed value', async () => {
  const { manager, clients } = setup({ clientOptions: { confirmWrites: false } });
  try {
    await assert.rejects(manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }, false), /did not confirm/);
    assert.equal(publishes(clients[0]).length, 1);
    assert.equal(clients[0].system.zones[0].hspC, 20);
    assert.equal(clients[0].closed, true);
  } finally { await manager.close(); }
});

test('missing fresh state or updates from another zone cannot authorize a write', async () => {
  for (const clientOptions of [{ freshResponses: false }, { refreshZones: [1] }]) {
    const { manager, clients } = setup({ clientOptions });
    try {
      await assert.rejects(manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }, false), /No fresh thermostat response/);
      assert.equal(publishes(clients[0]).length, 0);
    } finally { await manager.close(); }
  }
});

test('a rejected write releases the connection and a later retry can succeed', async () => {
  const { manager, clients } = setup({ clientOptions: index => ({ rejectWrite: index === 0 }) });
  try {
    await assert.rejects(manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }, false), /write rejected/);
    assert.equal(clients[0].closed, true);
    const state = await manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }, false);
    assert.equal(state.heat_target, 21);
    assert.equal(clients.length, 2);
  } finally { await manager.close(); }
});

test('background polling and commands never overlap on a shared controller connection', async () => {
  const { manager, clients } = setup();
  const states = [];
  const remove = manager.attach(HOST, SERIAL, 0, state => states.push(state), () => {});
  let unblock;
  try {
    await eventually(() => states.length > 0, 'Initial snapshot should arrive');
    clients[0].blockNextPoll = new Promise(resolve => { unblock = resolve; });
    await eventually(() => clients[0].blocked, 'A background poll should be in progress');
    const command = manager.command(HOST, SERIAL, 0, { type: 'heat', value: 21 }, false);
    await tick();
    assert.equal(publishes(clients[0]).length, 0, 'The queued command must wait for the in-flight poll');
    unblock();
    assert.equal((await command).heat_target, 21);
    assert.equal(clients[0].maxActive, 1);
  } finally { unblock?.(); await remove(); await manager.close(); }
});

test('app shutdown closes connections and rejects new pairing, subscriptions, and control attempts', async () => {
  const { manager, clients } = setup();
  const states = [];
  manager.attach(HOST, SERIAL, 0, state => states.push(state), () => {});
  await eventually(() => states.length > 0, 'Initial snapshot should arrive');
  await manager.close();
  const count = clients[0].events.length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(clients[0].events.length, count);
  assert.equal(clients[0].closed, true);
  assert.equal(manager.sessions.size, 0);
  await assert.rejects(manager.inspect(HOST), /shutting down/);
  assert.throws(() => manager.attach(HOST, SERIAL, 0, () => {}, () => {}), /shutting down/);
  await assert.rejects(manager.command(HOST, SERIAL, 0, { type: 'mode', value: 'off' }, false), /shutting down/);
});

function wireManager(emulator, options = {}) {
  return new SessionManager({ pollMs: 5, connectTimeoutMs: 300, confirmTimeoutMs: 100,
    clientFactory: () => new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 200 }),
    ...options });
}

test('the real pinned parser pairs emulator zones and confirms a partial setpoint command over HTTP', async () => {
  const emulator = await createEmulator();
  const manager = wireManager(emulator);
  try {
    const devices = await manager.inspect(emulator.host);
    assert.deepEqual(devices.map(device => device.data.id), [`${SERIAL}:0`, `${SERIAL}:1`]);
    const originalOtherZone = structuredClone(emulator.state.zones[1]);
    const originalPeriod = structuredClone(emulator.state.zones[0].status.period);
    const state = await manager.command(emulator.host, SERIAL, 0, { type: 'heat', value: 21 }, false);
    assert.equal(state.heat_target, 21);
    const events = emulator.events.filter(event => event.route === 'publish');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data.Data.schedules[0].schedule.periods[0].period, { hspC: 21, hsp: 70 });
    assert.deepEqual(emulator.state.zones[1], originalOtherZone);
    assert.deepEqual(emulator.state.zones[0].status.period, { ...originalPeriod, hspC: 21, hsp: 70 });
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.close(); await emulator.close(); }
});

test('an S40 controller identified only by equipment features pairs during continuous traffic and excludes unused zones', async () => {
  const emulator = await createEmulator({ model: 'S40', zones: 4, central: true });
  const state = emulator.state;
  delete state.system.registration.serialNumber;
  state.devices = [];
  state.system.config.centralMode = true;
  state.zones[0].status.temperatureC = 24.5;
  state.zones[0].status.temperature = 76.1;
  for (const zone of state.zones.slice(1)) {
    zone.config.heatingOption = null;
    zone.config.coolingOption = null;
    zone.status.temperatureC = null;
    zone.status.temperature = null;
    zone.status.temperatureStatus = 'not_available';
    zone.status.humidity = null;
    zone.status.humidityStatus = 'not_available';
  }
  state.equipments[0].equipment.features = [
    { id: 0, feature: { fid: 32773, name: 'Product Type', values: [{ id: 0, value: 'S40' }] } },
    { id: 1, feature: { fid: 15, name: 'Equipment Type Name', values: [{ id: 0, value: 'System' }] } },
    { id: 2, feature: { fid: 9, name: 'Control Serial Number', values: [{ id: 0, value: 'EMU-CONTROLLER-S40' }] } },
  ];
  // Every retrieval deliberately remains nonempty, reproducing the observed
  // S40 connection instead of requiring an idle response after subscription.
  emulator.setBehavior('retrieve', { status: 200, body: { messages: [
    { MessageID: '1', SenderID: 'LCC', MessageType: 'Notification', Data: state },
  ] } });
  const manager = wireManager(emulator, { connectTimeoutMs: 300, catalogSettleMs: 50 });
  try {
    const devices = await manager.inspect(emulator.host);
    assert.equal(devices.length, 1);
    assert.deepEqual(devices[0].data, { id: 'EMU-CONTROLLER-S40:0' });
    assert.deepEqual(devices[0].store, { serial: 'EMU-CONTROLLER-S40', zoneId: 0 });
    assert.equal(devices[0].settings.read_only, true);
    assert.ok(devices[0].capabilities.includes('heat_target'));
    assert.ok(devices[0].capabilities.includes('cool_target'));
    assert.ok(emulator.events.filter(event => event.route === 'retrieve').length > 1);
    assert.equal(emulator.events.filter(event => event.route === 'publish').length, 0);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.close(); await emulator.close(); }
});

test('the real protocol session rejects a successful ACK when the thermostat keeps reporting the old value', async () => {
  const emulator = await createEmulator({ ignoreCommands: true });
  const manager = wireManager(emulator, { confirmTimeoutMs: 40 });
  try {
    await assert.rejects(manager.command(emulator.host, SERIAL, 0, { type: 'heat', value: 21 }, false), /did not confirm/);
    assert.equal(emulator.events.filter(event => event.route === 'publish').length, 1);
    assert.equal(emulator.state.zones[0].status.period.hspC, 20);
  } finally { await manager.close(); await emulator.close(); }
});

test('a reachable controller that never reports its identity cannot be paired or controlled', async () => {
  const emulator = await createEmulator({ noInitialData: true });
  const manager = wireManager(emulator, { connectTimeoutMs: 35 });
  try {
    await assert.rejects(manager.inspect(emulator.host), /controller identity/);
    assert.equal(emulator.events.filter(event => event.route === 'publish').length, 0);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.close(); await emulator.close(); }
});

test('shutdown aborts a hanging real HTTP poll and stops subsequent retries', async () => {
  const emulator = await createEmulator();
  const manager = wireManager(emulator);
  const states = [];
  manager.attach(emulator.host, SERIAL, 0, state => states.push(state), () => {});
  try {
    await eventually(() => states.length > 0, 'The emulated device should connect');
    emulator.setBehavior('retrieve', { hang: true });
    const polls = emulator.events.filter(event => event.route === 'retrieve').length;
    await eventually(() => emulator.events.filter(event => event.route === 'retrieve').length > polls, 'A hanging poll should be in progress');
    await manager.close();
    const count = emulator.events.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(emulator.events.length, count);
    assert.equal(manager.sessions.size, 0);
  } finally { await manager.close(); await emulator.close(); }
});
