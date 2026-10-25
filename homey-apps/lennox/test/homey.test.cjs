'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { candidate: modelCandidate, normalizeZone } = require('../lib/model');

const root = path.resolve(__dirname, '..');
const supported = ['measure_temperature', 'thermostat_mode', 'hvac_state', 'heat_target', 'cool_target', 'fan_mode'];
const candidate = host => ({ name: 'Living room', data: { id: 'serial123:0' }, settings: { host, read_only: true }, store: { serial: 'serial123', zoneId: 0 }, capabilities: supported });

function thermostatMetadata({ single = false, mode = 'heat and cool', zoneOverrides = {} } = {}) {
  const system = { serialNumber: 'serial123', name: 'Living room', singleSetpointMode: single };
  const zone = { id: 0, name: 'Main zone', temperatureC: 21, humidity: 43,
    temperatureStatus: 'good', humidityStatus: 'good', systemMode: mode, tempOperation: 'off', fanMode: 'auto',
    heatingOption: true, coolingOption: true, hspC: 20, cspC: 25, spC: 22,
    minHspC: 10, maxHspC: 32, minCspC: 15.5, maxCspC: 35, ...zoneOverrides };
  return { candidate: modelCandidate(system, zone, '192.0.2.10'), state: normalizeZone(system, zone) };
}

class Sessions {
  constructor() { this.connections = []; this.inspections = []; this.commands = []; this.closed = false; }
  async inspect(host) {
    this.inspections.push(host);
    if (this.inspectResult) return this.inspectResult(host);
    return [candidate(host)];
  }
  attach(host, serial, zoneId, onState, onUnavailable) {
    if (this.attachError) throw this.attachError;
    const connection = { host, serial, zoneId, onState, onUnavailable, removed: false };
    this.connections.push(connection);
    return async () => { connection.removed = true; };
  }
  async command(...args) {
    this.commands.push(args);
    if (args[4]) throw new Error('Read-only mode is enabled');
    if (this.commandError) throw this.commandError;
  }
  async close() { this.closed = true; }
}

class Entity {
  log() {}
  error(...args) { (this.errors ||= []).push(args); }
}

class Device extends Entity {
  constructor(sessions) {
    super();
    this.settings = { host: '192.0.2.10', read_only: true };
    this.store = { serial: 'serial123', zoneId: 0 };
    this.capabilities = [...supported];
    this.values = {};
    this.capabilityOptions = {};
    this.optionUpdates = [];
    this.removedCapabilities = [];
    this.listeners = new Map();
    this.available = true;
    this.homey = { app: { sessions } };
  }
  getSetting(key) { return this.settings[key]; }
  getSettings() { return this.settings; }
  async setSettings(settings) {
    if (this.settingsError) throw this.settingsError;
    Object.assign(this.settings, settings);
  }
  getStoreValue(key) { return this.store[key]; }
  getData() { return { id: 'serial123:0' }; }
  hasCapability(capability) { return this.capabilities.includes(capability); }
  async addCapability(capability) { this.capabilities.push(capability); }
  async removeCapability(capability) {
    this.removedCapabilities.push(capability);
    this.capabilities = this.capabilities.filter(item => item !== capability);
    delete this.values[capability];
    delete this.capabilityOptions[capability];
    this.listeners.delete(capability);
  }
  async setCapabilityOptions(capability, options) {
    this.capabilityOptions[capability] = JSON.parse(JSON.stringify(options));
    this.optionUpdates.push(capability);
  }
  registerCapabilityListener(capability, callback) { this.listeners.set(capability, callback); }
  async setCapabilityValue(capability, value) {
    if (this.updateGate) await this.updateGate(capability);
    this.values[capability] = value;
  }
  getCapabilityValue(capability) { return this.values[capability]; }
  async setAvailable() { this.available = true; this.unavailable = undefined; }
  async setUnavailable(message) { this.available = false; this.unavailable = message; }
  getAvailable() { return this.available; }
}

const homey = { App: Entity, Driver: Entity, Device };

function load(relative) {
  const filename = path.join(root, relative);
  const actualRequire = createRequire(filename);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: request => {
    if (request === 'homey') return homey;
    if (request === './lib/session') return { SessionManager: Sessions };
    return actualRequire(request);
  }, console, Promise });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return module.exports;
}

const LennoxDevice = load('drivers/thermostat/device.js');
const LennoxDriver = load('drivers/thermostat/driver.js');

function pairSession() {
  const handlers = new Map();
  return { handlers, setHandler: (event, handler) => handlers.set(event, handler) };
}

async function deviceFixture() {
  const sessions = new Sessions();
  const device = new LennoxDevice(sessions);
  await device.onInit();
  return { device, sessions };
}

test('app creates one shared manager and closes it when unloaded', async () => {
  const App = load('app.js');
  const app = new App();
  await app.onInit();
  assert.ok(app.sessions instanceof Sessions);
  await app.onUninit();
  assert.equal(app.sessions.closed, true);
});

test('pairing connects read-only, clears old choices after failure and supports retry/reopen', async () => {
  const sessions = new Sessions();
  const driver = new LennoxDriver();
  driver.homey = { app: { sessions } };
  const first = pairSession();
  await driver.onPair(first);
  await first.handlers.get('connect')({ host: ' 192.0.2.10 ' });
  assert.equal((await first.handlers.get('list_devices')())[0].settings.read_only, true);
  sessions.inspectResult = async () => { throw new Error('Device offline'); };
  await assert.rejects(first.handlers.get('connect')({ host: '192.0.2.20' }), /offline/);
  assert.equal((await first.handlers.get('list_devices')()).length, 0);
  sessions.inspectResult = null;
  await first.handlers.get('connect')({ host: '192.0.2.20' });
  assert.equal((await first.handlers.get('list_devices')())[0].settings.host, '192.0.2.20');
  await first.handlers.get('disconnect')();
  await assert.rejects(first.handlers.get('connect')({ host: '192.0.2.10' }), /closed/);
  const second = pairSession();
  await driver.onPair(second);
  assert.equal((await second.handlers.get('list_devices')()).length, 0);
  await second.handlers.get('connect')({ host: '192.0.2.10' });
  assert.equal((await second.handlers.get('list_devices')()).length, 1);
  assert.equal(sessions.commands.length, 0);
});

test('a cancelled or superseded pairing probe cannot repopulate the device list', async () => {
  const sessions = new Sessions();
  const driver = new LennoxDriver();
  driver.homey = { app: { sessions } };
  const pair = pairSession();
  await driver.onPair(pair);
  let complete;
  sessions.inspectResult = () => new Promise(resolve => { complete = resolve; });
  const pending = pair.handlers.get('connect')({ host: '192.0.2.10' });
  await pair.handlers.get('disconnect')();
  complete([candidate('192.0.2.10')]);
  await assert.rejects(pending, /superseded/);
  assert.equal((await pair.handlers.get('list_devices')()).length, 0);
});

test('device recovers from unavailable readings without recreating its identity', async () => {
  const { device, sessions } = await deviceFixture();
  assert.equal(device.getAvailable(), false);
  sessions.connections[0].onState({ measure_temperature: 21, thermostat_mode: 'auto', unsupported: 1 });
  await device._updates;
  assert.equal(device.getAvailable(), true);
  assert.equal(device.values.measure_temperature, 21);
  assert.equal('unsupported' in device.values, false);
  sessions.connections[0].onUnavailable('Network unavailable');
  await device._updates;
  assert.equal(device.getAvailable(), false);
  assert.equal(device.values.measure_temperature, 21);
  sessions.connections[0].onState({ measure_temperature: 22, hvac_state: 'heating' });
  await device._updates;
  assert.equal(device.getAvailable(), true);
  assert.equal(device.values.hvac_state, 'heating');
  assert.equal(sessions.connections.length, 1);
  await device.onUninit();
  assert.equal(sessions.connections[0].removed, true);
});

test('fragmented metadata adds later controls and updates their limits without restarting', async () => {
  const sessions = new Sessions();
  const device = new LennoxDevice(sessions);
  device.capabilities = ['measure_temperature', 'thermostat_mode', 'hvac_state'];
  await device.onInit();
  const connection = sessions.connections[0];
  const initial = { ...candidate('192.0.2.10'), capabilities: [...device.capabilities], capabilitiesOptions: {} };
  connection.onState({ measure_temperature: 21, hvac_state: 'unknown' }, initial);
  await device._updates;
  assert.equal(device.hasCapability('heat_target'), false);
  const full = { ...candidate('192.0.2.10'), capabilities: [...supported, 'measure_humidity'],
    capabilitiesOptions: { heat_target: { min: 8, max: 28, step: 0.5 }, cool_target: { min: 16, max: 35, step: 0.5 } } };
  connection.onState({ measure_temperature: 21, measure_humidity: 43, heat_target: 20, cool_target: 25, fan_mode: 'auto' }, full);
  await device._updates;
  assert.equal(device.hasCapability('heat_target'), true);
  assert.equal(device.hasCapability('measure_humidity'), true);
  assert.equal(device.values.measure_humidity, 43);
  assert.equal(device.values.cool_target, 25);
  await assert.rejects(device.listeners.get('heat_target')(21), /Read-only/);
  assert.deepEqual(device.capabilityOptions.heat_target, { min: 8, max: 28, step: 0.5 });
  const updates = device.optionUpdates.length;
  connection.onState({ measure_temperature: 22 }, JSON.parse(JSON.stringify(full)));
  await device._updates;
  assert.equal(device.optionUpdates.length, updates);
  connection.onState({ measure_temperature: 22 }, { ...full,
    capabilitiesOptions: { ...full.capabilitiesOptions, heat_target: { min: 10, max: 27, step: 0.5 } } });
  await device._updates;
  assert.deepEqual(device.capabilityOptions.heat_target, { min: 10, max: 27, step: 0.5 });
  assert.equal(device.optionUpdates.length, updates + 1);
  await device.onUninit();
});

test('single/dual mode switches request UI overrides and neutralize retained groups while preserving legacy IDs, history and Flows', async () => {
  const { device, sessions } = await deviceFixture();
  const connection = sessions.connections[0];
  const dual = thermostatMetadata();
  connection.onState(dual.state, dual.candidate);
  await device._updates;
  const originalIds = [...device.capabilities];
  assert.equal(device.values.heat_target, 20);
  assert.equal(device.values.cool_target, 25);
  assert.equal(device.values['target_temperature.heat'], 20);
  const single = thermostatMetadata({ single: true });
  connection.onState(single.state, single.candidate);
  await device._updates;
  assert.equal(device.hasCapability('target_temperature'), true);
  for (const capability of originalIds) assert.equal(device.hasCapability(capability), true, `Preserve ${capability}`);
  assert.equal(device.values.heat_target, 20);
  assert.equal(device.values.cool_target, 25);
  assert.equal(device.listeners.has('heat_target'), true);
  assert.equal(device.capabilityOptions.target_temperature.uiComponent, 'thermostat');
  assert.equal(device.capabilityOptions['target_temperature.heat'].uiComponent, null);
  assert.equal(device.capabilityOptions['target_temperature.cool'].uiComponent, null);
  assert.equal(device.values['thermostat_mode.heat'], 'off');
  assert.equal(device.values['thermostat_mode.cool'], 'off');
  assert.equal(device.values['measure_temperature.heat'], device.values.measure_temperature);
  assert.equal(device.values['measure_temperature.cool'], device.values.measure_temperature);
  assert.equal(device.values['target_temperature.heat'], 20);
  assert.equal(device.values['target_temperature.cool'], 25);
  await assert.rejects(device.listeners.get('target_temperature')(23), /Read-only/);
  assert.equal(sessions.commands.at(-1)[3].type, 'target');
  connection.onState({ measure_temperature: 22 }, { ...candidate('192.0.2.10'), capabilities: ['measure_temperature'], capabilitiesOptions: {} });
  await device._updates;
  assert.equal(device.hasCapability('thermostat_mode'), true);
  assert.equal(device.hasCapability('target_temperature'), true);
  assert.equal(device.hasCapability('measure_humidity'), true);
  assert.equal(device.values.measure_humidity, 43);
  assert.equal(device.capabilityOptions['target_temperature.heat'].uiComponent, null);
  connection.onState(dual.state, dual.candidate);
  await device._updates;
  assert.equal(device.hasCapability('target_temperature'), true);
  assert.equal(device.values.target_temperature, null, 'Confirmed dual automatic mode clears the retained scalar value; this does not prove its native dial is removed');
  assert.equal(device.capabilityOptions.target_temperature.uiComponent, null);
  assert.equal(device.capabilityOptions['target_temperature.heat'].uiComponent, 'thermostat');
  assert.equal(device.capabilityOptions['target_temperature.cool'].uiComponent, 'thermostat');
  assert.equal(device.hasCapability('heat_target'), true);
  assert.equal(device.hasCapability('cool_target'), true);
  await assert.rejects(device.listeners.get('heat_target')(21), /Read-only/);
  assert.equal(sessions.commands.at(-1)[3].type, 'heat');
  assert.deepEqual(device.removedCapabilities, []);
  assert.equal(device.getData().id, 'serial123:0');
  assert.equal(device.getSetting('read_only'), true);
  await device.onUninit();
});

test('native target listeners are registered for existing devices and later metadata without bypassing write policy', async () => {
  for (const existing of [true, false]) {
    const sessions = new Sessions();
    const device = new LennoxDevice(sessions);
    const metadata = thermostatMetadata();
    if (existing) device.capabilities = [...metadata.candidate.capabilities];
    await device.onInit();
    sessions.connections[0].onState(metadata.state, metadata.candidate);
    await device._updates;
    for (const [type, value] of [['heat', 21], ['cool', 24]]) {
      const capability = `target_temperature.${type}`;
      assert.equal(typeof device.listeners.get(capability), 'function');
      await assert.rejects(device.listeners.get(capability)(value), /Read-only/);
      assert.equal(sessions.commands.at(-1)[4], true);
      assert.equal(sessions.commands.at(-1)[3].type, type);
      device.settings.read_only = false;
      sessions.commandError = Error('Thermostat did not confirm');
      await assert.rejects(device.listeners.get(capability)(value), /did not confirm/);
      assert.equal(device.values[capability], type === 'heat' ? 20 : 25);
      sessions.commandError = null;
      await device.listeners.get(capability)(value);
      assert.deepEqual(JSON.parse(JSON.stringify(sessions.commands.at(-1)[3])), { type, value });
      assert.equal(sessions.commands.at(-1)[4], false);
      device.settings.read_only = true;
    }
    const commands = sessions.commands.length;
    for (const capability of ['thermostat_mode.heat', 'thermostat_mode.cool']) {
      await assert.rejects(device.listeners.get(capability)('heat'), /Use the main thermostat mode control/);
    }
    assert.equal(sessions.commands.length, commands, 'Direction helpers must never send mode changes');
    assert.deepEqual(device.removedCapabilities, []);
    await device.onUninit();
  }
});

test('explicitly unsupported cooling requests a UI override and clears direction while preserving legacy values and partial metadata', async () => {
  const { device, sessions } = await deviceFixture();
  const connection = sessions.connections[0];
  const original = thermostatMetadata({ zoneOverrides: { temperatureC: 23, hspC: 18, cspC: 22 } });
  connection.onState(original.state, original.candidate);
  await device._updates;
  const originalIds = [...device.capabilities];
  assert.equal(device.values['thermostat_mode.cool'], 'cool');
  assert.equal(device.values['target_temperature.cool'], 22);
  assert.equal(device.capabilityOptions['target_temperature.cool'].uiComponent, 'thermostat');
  const partial = thermostatMetadata({ zoneOverrides: { temperatureC: 24, coolingOption: undefined, cspC: null } });
  connection.onState(partial.state, partial.candidate);
  await device._updates;
  assert.equal(device.capabilityOptions['target_temperature.cool'].uiComponent, 'thermostat');
  assert.equal(device.values['measure_temperature.cool'], 24, 'An absent target must not freeze the shared room measurement');
  const heatOnly = thermostatMetadata({ mode: 'heat', zoneOverrides: { temperatureC: 23, coolingOption: false, cspC: 22 } });
  connection.onState(heatOnly.state, heatOnly.candidate);
  await device._updates;
  assert.equal(device.capabilityOptions['target_temperature.cool'].uiComponent, null);
  assert.equal(device.values['thermostat_mode.cool'], 'off');
  assert.equal(device.values['target_temperature.cool'], 22);
  assert.equal(device.values.cool_target, 22);
  assert.equal(device.values['measure_temperature.cool'], 23);
  for (const capability of originalIds) assert.equal(device.hasCapability(capability), true);
  assert.deepEqual(device.removedCapabilities, []);
  assert.equal(device.getSetting('read_only'), true);
  connection.onState(original.state, original.candidate);
  await device._updates;
  assert.equal(device.capabilityOptions['target_temperature.cool'].uiComponent, 'thermostat');
  assert.equal(device.values['thermostat_mode.cool'], 'cool');
  await device.onUninit();
});

test('control listeners pass read-only policy and never claim a failed write succeeded', async () => {
  const { device, sessions } = await deviceFixture();
  sessions.connections[0].onState({ heat_target: 20 });
  await device._updates;
  await assert.rejects(device.listeners.get('heat_target')(21), /Read-only/);
  assert.equal(sessions.commands[0][4], true);
  assert.equal(device.values.heat_target, 20);
  device.settings.read_only = false;
  sessions.commandError = new Error('Thermostat did not confirm');
  await assert.rejects(device.listeners.get('heat_target')(21), /did not confirm/);
  assert.equal(sessions.commands[1][4], false);
  assert.deepEqual(JSON.parse(JSON.stringify(sessions.commands[1][3])), { type: 'heat', value: 21 });
  assert.equal(device.values.heat_target, 20);
  sessions.commandError = null;
  await device.listeners.get('heat_target')(21);
  sessions.connections[0].onState({ heat_target: 21 });
  await device._updates;
  assert.equal(device.values.heat_target, 21);
  await device.onUninit();
});

test('invalid setting edits and different thermostat identities preserve the live connection', async () => {
  const { device, sessions } = await deviceFixture();
  await assert.rejects(device.onSettings({ newSettings: { host: 'http://wrong/', read_only: true }, changedKeys: ['host'] }), /without a URL/);
  sessions.inspectResult = async host => [{ ...candidate(host), data: { id: 'different:0' } }];
  await assert.rejects(device.onSettings({ newSettings: { host: '192.0.2.20', read_only: true }, changedKeys: ['host'] }), /different thermostat/);
  assert.equal(sessions.connections.length, 1);
  assert.equal(sessions.connections[0].removed, false);
  assert.equal(device._host, '192.0.2.10');
  sessions.connections[0].onState({ measure_temperature: 21 });
  await device._updates;
  assert.equal(device.values.measure_temperature, 21);
  await device.onUninit();
});

test('successful settings change detaches old host and rejects its later callbacks', async () => {
  const { device, sessions } = await deviceFixture();
  const oldConnection = sessions.connections[0];
  await device.onSettings({ newSettings: { host: '192.0.2.20', read_only: true }, changedKeys: ['host'] });
  assert.equal(oldConnection.removed, true);
  assert.equal(device._host, '192.0.2.20');
  oldConnection.onState({ measure_temperature: 99 });
  sessions.connections[1].onState({ measure_temperature: 22 });
  await device._updates;
  assert.equal(device.values.measure_temperature, 22);
  await device.onUninit();
});

test('repair persists a verified address and retains control policy after reopening', async () => {
  const { device, sessions } = await deviceFixture();
  device.settings.read_only = false;
  const driver = new LennoxDriver();
  const repair = pairSession();
  await driver.onRepair(repair, device);
  assert.equal((await repair.handlers.get('repair_info')()).host, '192.0.2.10');
  await repair.handlers.get('connect')({ host: '192.0.2.30' });
  assert.equal(device.getSetting('host'), '192.0.2.30');
  assert.equal(device.getSetting('read_only'), false);
  assert.equal(sessions.connections[0].removed, true);
  await device.onUninit();
  const reopened = new LennoxDevice(sessions);
  reopened.settings = { ...device.settings };
  await reopened.onInit();
  assert.equal(reopened._host, '192.0.2.30');
  await reopened.onUninit();
});

test('repair failure and persistence failure leave the existing host subscribed', async () => {
  const { device, sessions } = await deviceFixture();
  sessions.inspectResult = async () => { throw new Error('Connection timeout'); };
  await assert.rejects(device.reconnectHost('192.0.2.20'), /timeout/);
  assert.equal(device.getSetting('host'), '192.0.2.10');
  assert.equal(sessions.connections[0].removed, false);
  sessions.inspectResult = null;
  device.settingsError = new Error('Settings could not be saved');
  await assert.rejects(device.reconnectHost('192.0.2.20'), /could not be saved/);
  assert.equal(sessions.connections.length, 1);
  assert.equal(device.getSetting('host'), '192.0.2.10');
  assert.equal(sessions.connections[0].removed, false);
  await device.onUninit();
});

test('repair rolls settings back if the replacement subscription cannot be created', async () => {
  const { device, sessions } = await deviceFixture();
  sessions.attachError = new Error('App is shutting down');
  await assert.rejects(device.reconnectHost('192.0.2.20'), /shutting down/);
  assert.equal(device.getSetting('host'), '192.0.2.10');
  assert.equal(device._host, '192.0.2.10');
  assert.equal(sessions.connections[0].removed, false);
  await device.onUninit();
});

test('shutdown rejects control and ignores late status callbacks', async () => {
  const { device, sessions } = await deviceFixture();
  await device.onDeleted();
  sessions.connections[0].onState({ measure_temperature: 50 });
  await device._updates;
  assert.equal(device.values.measure_temperature, undefined);
  await assert.rejects(device.writeCommand({ type: 'mode', value: 'off' }), /stopping/);
  await device.onUninit();
  assert.equal(sessions.commands.length, 0);
});

test('a repair completing after the device is deleted cannot reopen its session', async () => {
  const { device, sessions } = await deviceFixture();
  let complete;
  sessions.inspectResult = () => new Promise(resolve => { complete = resolve; });
  const pending = device.reconnectHost('192.0.2.20');
  await device.onDeleted();
  complete([candidate('192.0.2.20')]);
  await assert.rejects(pending, /stopping/);
  assert.equal(sessions.connections.length, 1);
  assert.equal(sessions.connections[0].removed, true);
  assert.equal(device.getSetting('host'), '192.0.2.10');
});

test('Flow controls use the same confirmed command path and unavailable conditions fail', async () => {
  const cards = new Map();
  const flow = { getActionCard: id => ({ registerRunListener: callback => cards.set(id, callback) }),
    getConditionCard: id => ({ registerRunListener: callback => cards.set(id, callback) }) };
  const driver = new LennoxDriver();
  driver.homey = { flow };
  await driver.onInit();
  const commands = [];
  const device = { writeCommand: async command => commands.push(command), getAvailable: () => true, getCapabilityValue: () => 'heating' };
  await cards.get('heat_target_set')({ device, temperature: 21 });
  await cards.get('cool_target_set')({ device, temperature: 25 });
  await cards.get('fan_mode_set')({ device, mode: 'circulate' });
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [{ type: 'heat', value: 21 }, { type: 'cool', value: 25 }, { type: 'fan', value: 'circulate' }]);
  assert.equal(await cards.get('hvac_state_is')({ device, state: 'heating' }), true);
  device.getAvailable = () => false;
  await assert.rejects(cards.get('hvac_state_is')({ device, state: 'heating' }), /unavailable/);
});

function pairingPage({ repair = false, emit } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const windowListeners = new Map();
  for (const id of ['connect-form', 'host', 'connect', 'status', 'title', 'subtitle', 'read-only-note']) {
    elements.set(id, { value: '', disabled: false, hidden: false, textContent: '', focus() {}, reportValidity: () => true,
      addEventListener: (event, callback) => listeners.set(id + ':' + event, callback) });
  }
  const alerts = [], views = [], events = [];
  let done = false;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const driver = manifest.drivers.find(item => item.id === 'thermostat');
  const group = repair ? 'repair' : 'pair';
  const view = driver[group].find(item => !item.template);
  const Homey = { getOptions: async () => view.options || {}, __: key => key, setTitle() {},
    emit: async (event, data) => { events.push([event, data]); return emit ? emit(event, data) : {}; },
    alert: async (message, icon) => alerts.push([message, icon]), showView: view => views.push(view), done: () => { done = true; } };
  const html = fs.readFileSync(path.join(root, 'drivers/thermostat', group, `${view.id}.html`), 'utf8');
  const source = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(source, { document: { getElementById: id => elements.get(id) }, Homey,
    window: { addEventListener: (event, callback) => windowListeners.set(event, callback) } });
  return { elements, alerts, views, events, windowListeners, isDone: () => done,
    submit: () => listeners.get('connect-form:submit')({ preventDefault() {} }) };
}

async function microtasks() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

test('pairing and repair both ship their declared custom view and keep the shared form synchronized', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const driver = manifest.drivers.find(item => item.id === 'thermostat');
  const contents = {};
  for (const group of ['pair', 'repair']) {
    for (const view of driver[group].filter(item => !item.template)) {
      const filename = path.join(root, 'drivers/thermostat', group, `${view.id}.html`);
      assert.equal(fs.existsSync(filename), true, `Missing ${group} view ${view.id}`);
      contents[group] = fs.readFileSync(filename, 'utf8');
    }
  }
  assert.equal(contents.repair, contents.pair, 'Repair and pairing copies must receive the same shared form changes');
});

test('pairing UI retries via Homey modals without native prompts or browser storage', async () => {
  let fail = true;
  const page = pairingPage({ emit: async () => { if (fail) throw new Error('Network unreachable'); return { count: 1 }; } });
  await microtasks();
  page.elements.get('host').value = ' 192.0.2.10 ';
  await page.submit();
  assert.equal(page.alerts[0][0], 'Network unreachable');
  assert.equal(page.elements.get('connect').disabled, false);
  assert.equal(page.views.length, 0);
  fail = false;
  await page.submit();
  assert.equal(page.views[0], 'list_devices');
  assert.equal(page.events[1][1].host, '192.0.2.10');
});

test('pairing UI ignores completion after navigation away and repair reuses the saved host', async () => {
  let complete;
  const page = pairingPage({ emit: () => new Promise(resolve => { complete = resolve; }) });
  await microtasks();
  page.elements.get('host').value = '192.0.2.10';
  const pending = page.submit();
  page.windowListeners.get('pagehide')();
  complete({ count: 1 });
  await pending;
  assert.equal(page.views.length, 0);
  const repaired = pairingPage({ repair: true, emit: async event => event === 'repair_info' ? { host: '192.0.2.20' } : { repaired: true } });
  await microtasks();
  assert.equal(repaired.elements.get('host').value, '192.0.2.20');
  assert.equal(repaired.elements.get('read-only-note').hidden, true);
  await repaired.submit();
  assert.equal(repaired.isDone(), true);
  assert.equal(repaired.views.length, 0);
  assert.equal(repaired.alerts[0][1], 'info');
});

test('the actual repair view supports a failed connection, retry, and reopening with the repaired address', async () => {
  let fail = true;
  let savedHost = '192.0.2.20';
  const emit = async (event, data) => {
    if (event === 'repair_info') return { host: savedHost };
    if (fail) throw Error('Thermostat unreachable');
    savedHost = data.host;
    return { repaired: true };
  };
  const page = pairingPage({ repair: true, emit });
  await microtasks();
  assert.equal(page.elements.get('host').value, '192.0.2.20');
  page.elements.get('host').value = '192.0.2.30';
  await page.submit();
  assert.equal(page.isDone(), false);
  assert.equal(page.alerts[0][0], 'Thermostat unreachable');
  assert.equal(page.elements.get('connect').disabled, false);
  assert.equal(page.elements.get('host').disabled, false);
  assert.equal(savedHost, '192.0.2.20');
  fail = false;
  await page.submit();
  assert.equal(page.isDone(), true);
  assert.equal(savedHost, '192.0.2.30');
  assert.equal(page.views.length, 0);
  const reopened = pairingPage({ repair: true, emit });
  await microtasks();
  assert.equal(reopened.isDone(), false);
  assert.equal(reopened.elements.get('host').value, '192.0.2.30');
  assert.equal(reopened.elements.get('read-only-note').hidden, true);
  await reopened.submit();
  assert.equal(reopened.isDone(), true);
  assert.equal(reopened.views.length, 0);
});
