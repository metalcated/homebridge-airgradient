const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { emulator } = require('./emulator.cjs');
const { SensorStore } = require('../dist/storage');

const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) { throw new Error('Timed out waiting for plugin state'); } await new Promise(r => setTimeout(r, 10)); }
};
async function harness(config) {
  const root = dirname(require.resolve('homebridge'));
  const { HomebridgeAPI } = await import(pathToFileURL(join(root, 'api.js')));
  const api = new HomebridgeAPI();
  const storage = mkdtempSync(join(tmpdir(), 'airgradient-test-'));
  api.user.storagePath = () => storage;
  let Platform; let registrations = 0; let removals = 0;
  api.registerPlatform = (name, alias, constructor) => { assert.equal(name, 'homebridge-airgradient'); assert.equal(alias, 'AirGradientPlatform'); Platform = constructor; };
  api.registerPlatformAccessories = () => registrations++;
  api.unregisterPlatformAccessories = (name, alias, accessories) => { removals += accessories.length; };
  api.updatePlatformAccessories = () => {};
  const logs = []; const log = Object.assign((...args) => logs.push(args), Object.fromEntries(['info','warn','error','debug'].map(k => [k, (...args) => logs.push([k,...args])])));
  require('../dist/index')(api);
  const platform = new Platform(log, { platform: 'AirGradientPlatform', ...config }, api);
  return { api, platform, logs, storage, get registrations() { return registrations; }, get removals() { return removals; },
    launch() { api.emit('didFinishLaunching'); }, close() { api.emit('shutdown'); } };
}

for (const version of ['legacy', 'v1']) {
  test(`${version}: platform readings, custom indices, stale values, outage and recovery`, async t => {
    const device = await emulator(version); t.after(device.close);
    const h = await harness({ sensors: [{ ...device.settings, historyDays: 2, offlineAfterFailures: 2 }] }); t.after(() => h.close());
    h.launch(); const sensor = h.platform.sensors[0];
    await waitFor(() => sensor.lastSuccess);
    assert.equal(h.registrations, 1);
    const C = h.api.hap.Characteristic;
    const read = (service, type) => service.getCharacteristic(type);
    assert.equal(read(sensor.service, C.PM2_5Density).value, 7);
    assert(!sensor.service.testCharacteristic(C.VOCDensity)); assert(!sensor.service.testCharacteristic(C.NitrogenDioxideDensity));
    const voc = sensor.service.characteristics.find(c => c.displayName === 'VOC Index'); assert.equal(voc.value, 100); assert.equal(voc.props.unit, undefined);
    const co2key = version === 'v1' ? 'co2' : 'rco2';
    device.payload[co2key] = -1; await sensor.updateData(); await sensor.updateData();
    assert.notEqual(read(sensor.serviceCO2, C.CarbonDioxideLevel).statusCode, 0);
    assert.equal(read(sensor.serviceTemp, C.CurrentTemperature).statusCode, 0);
    device.payload[co2key] = 950; await sensor.updateData();
    assert.equal(read(sensor.serviceCO2, C.CarbonDioxideLevel).statusCode, 0);
    assert.equal(read(sensor.serviceCO2, C.CarbonDioxideDetected).value, 1);
    device.status = 500; await sensor.updateData(); await sensor.updateData(); assert.equal(sensor.offline, true);
    assert.notEqual(voc.statusCode, 0); assert.equal(h.removals, 0);
    device.status = 200; await sensor.updateData(); assert.equal(sensor.offline, false); assert.equal(voc.statusCode, 0);
    if (version === 'v1') { assert.equal(h.platform.sensors[0].accessory.getService(h.api.hap.Service.Battery).getCharacteristic(C.BatteryLevel).value, 72); assert(!sensor.accessory.getService(h.api.hap.Service.Battery).testCharacteristic(C.ChargingState)); }
    const store = new SensorStore(h.storage); t.after(() => store.close());
    assert(store.history('abc123').length >= 2); assert.equal(store.readDiagnostics('abc123').failures, 0); assert.equal(store.readDiagnostics('abc123').wifiRssi, version === 'v1' ? -55 : -52);
    const saved = JSON.stringify(store.readDiagnostics('abc123')); assert(!saved.includes('127.0.0.1')); assert(!saved.includes('mqtt'));
    sensor.stop(); const count = device.requests.length; await sensor.updateData(); await new Promise(r => setTimeout(r, 30)); assert.equal(device.requests.length, count);
  });
}

test('invalid configuration preserves cached accessories; intentional removal unregisters only removed sensors', async t => {
  for (const sensors of [undefined, {}, [{ serialno: '' }], [{ serialno: 'abc123', port: -1 }]]) {
    const h = await harness({ sensors }); t.after(() => h.close());
    const cached = new h.api.platformAccessory('Existing', h.api.hap.uuid.generate('abc123'));
    h.platform.configureAccessory(cached); h.launch(); assert.equal(h.removals, 0); assert.equal(h.registrations, 0);
    assert(h.logs.some(row => row[0] === 'error'));
  }
  const h = await harness({ sensors: [] }); t.after(() => h.close());
  h.platform.configureAccessory(new h.api.platformAccessory('Removed intentionally', h.api.hap.uuid.generate('abc123')));
  h.launch(); assert.equal(h.removals, 1);
});

test('restart restores cached accessory identity, room metadata, and legacy concentration errors', async t => {
  const device = await emulator(); t.after(device.close);
  const h = await harness({ sensors: [device.settings, device.settings] }); t.after(() => h.close());
  const accessory = new h.api.platformAccessory('My existing monitor', h.api.hap.uuid.generate('abc123'));
  accessory.context.room = 'Office'; accessory.context.serial = 'abc123';
  accessory.addService(h.api.hap.Service.AirQualitySensor).addCharacteristic(h.api.hap.Characteristic.VOCDensity);
  h.platform.configureAccessory(accessory); h.launch();
  await waitFor(() => h.platform.sensors[0].lastSuccess);
  assert.equal(h.registrations, 0); assert.equal(h.platform.sensors.length, 1); assert.equal(accessory.context.room, 'Office');
  assert.equal(accessory.displayName, 'My existing monitor');
  assert.notEqual(accessory.getService(h.api.hap.Service.AirQualitySensor).getCharacteristic(h.api.hap.Characteristic.VOCDensity).statusCode, 0);
});

test('brightness services are opt-in, preserve cached services and verify writes', async t => {
  const device = await emulator('v1'); t.after(device.close);
  const h = await harness({ sensors: [{ ...device.settings, enableDisplayControls: true }] }); t.after(() => h.close()); h.launch();
  const sensor = h.platform.sensors[0]; const S = h.api.hap.Service; const C = h.api.hap.Characteristic;
  await waitFor(() => sensor.accessory.getServiceById(S.Lightbulb, 'displayBrightness'));
  const display = sensor.accessory.getServiceById(S.Lightbulb, 'displayBrightness');
  await display.getCharacteristic(C.Brightness).handleSetRequest(12); assert.equal(device.config.displayBrightness, 12);
  await display.getCharacteristic(C.On).handleSetRequest(false); assert.equal(device.config.displayBrightness, 0);
  await display.getCharacteristic(C.On).handleSetRequest(true); assert.equal(device.config.displayBrightness, 12);
  device.writeStatus = 403; await assert.rejects(display.getCharacteristic(C.Brightness).handleSetRequest(15));
  assert.equal(device.config.displayBrightness, 12);
});

test('history disabled by default, retention expiry and reopening SQLite preserve valid rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'airgradient-store-')); const store = new SensorStore(root);
  store.append('abc', { rco2: 500 }, 0, 0); assert.equal(store.history('abc').length, 0);
  store.append('abc', { rco2: 500 }, 1, 0); store.append('abc', { rco2: 600 }, 1, 86400001);
  assert.equal(store.history('abc').length, 1); store.close();
  const reopened = new SensorStore(root); assert.equal(reopened.history('abc')[0].rco2, 600); reopened.close();
});

test('optional capabilities do not fabricate absent native services', async t => {
  const device = await emulator('v1'); t.after(device.close);
  device.payload = { serialNumber: 'abc123', model: 'minimal', firmware: '1.0.0', temperature: -5 };
  const h = await harness({ sensors: [device.settings] }); t.after(() => h.close()); h.launch();
  await waitFor(() => h.platform.sensors[0].lastSuccess);
  const accessory = h.platform.sensors[0].accessory; const S = h.api.hap.Service; const C = h.api.hap.Characteristic;
  assert.equal(accessory.getService(S.TemperatureSensor).getCharacteristic(C.CurrentTemperature).value, -5);
  assert.equal(accessory.getService(S.CarbonDioxideSensor), undefined);
  assert.equal(accessory.getService(S.HumiditySensor), undefined);
  assert.equal(accessory.getService(S.Battery), undefined);
  assert.equal(accessory.getService(S.Lightbulb), undefined);
  assert.equal(accessory.getService(S.AirQualitySensor), undefined);
});

test('all-invalid readings become offline; finite compensated fallback and recovery are bounded', async t => {
  const device = await emulator(); t.after(device.close);
  device.payload = { serialno: 'abc123', pm02: -1, rco2: -1, rhum: 200, atmp: -999 };
  const h = await harness({ sensors: [{ ...device.settings, offlineAfterFailures: 2, useCompensatedValues: true }] }); t.after(() => h.close()); h.launch();
  const sensor = h.platform.sensors[0]; await waitFor(() => sensor.consecutiveFailures === 1);
  await sensor.updateData(); assert.equal(sensor.offline, true); assert.equal(sensor.lastSuccess, undefined);
  device.payload = { serialno: 'abc123', pm02: 5, pm02Compensated: -1, rco2: 600, atmp: -4, atmpCompensated: -3,
    rhum: 50, rhumCompensated: 110 };
  await sensor.updateData(); assert.equal(sensor.offline, false);
  const C = h.api.hap.Characteristic;
  assert.equal(sensor.service.getCharacteristic(C.PM2_5Density).value, 5);
  assert.equal(sensor.serviceTemp.getCharacteristic(C.CurrentTemperature).value, -3);
  assert.equal(sensor.serviceHumid.getCharacteristic(C.CurrentRelativeHumidity).value, 50);
});

test('cached display controls remain unavailable when opt-in is revoked', async t => {
  const device = await emulator(); t.after(device.close);
  const h = await harness({ sensors: [device.settings] }); t.after(() => h.close());
  const accessory = new h.api.platformAccessory('Cached', h.api.hap.uuid.generate('abc123'));
  const display = accessory.addService(h.api.hap.Service.Lightbulb, 'Display', 'displayBrightness');
  display.addCharacteristic(h.api.hap.Characteristic.Brightness);
  h.platform.configureAccessory(accessory); h.launch(); await waitFor(() => h.platform.sensors[0].lastSuccess);
  await assert.rejects(display.getCharacteristic(h.api.hap.Characteristic.On).handleSetRequest(true));
  assert.equal(device.requests.filter(row => row.method === 'PUT').length, 0);
});
