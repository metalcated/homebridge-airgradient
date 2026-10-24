const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DeviceClient, baseUrl, normalize } = require('../dist/device');
const { validateSensors, Co2Alert } = require('../dist/config');
const { discoveryRecord, discover } = require('../dist/discovery');
const { emulator } = require('./emulator.cjs');

for (const version of ['legacy', 'v1']) {
  test(`${version}: real HTTP negotiation, identity and measurement normalization`, async t => {
    const device = await emulator(version); t.after(device.close);
    const client = new DeviceClient(device.settings); t.after(() => client.stop());
    const data = await client.measures();
    assert.equal(client.version, version); assert.equal(data.rco2, 600); assert.equal(data.pm02, 7);
    assert.equal(data.atmp, 22); assert.equal(data.wifi, version === 'v1' ? -55 : -52);
    const attempts = device.requests.length; await client.measures(); assert.equal(device.requests.length, attempts + 1);
    device.payload[version === 'v1' ? 'serialNumber' : 'serialno'] = 'different';
    await assert.rejects(client.measures(), /serial number/);
  });
  test(`${version}: partial config writes, delayed readback, failure, retry and rollback`, async t => {
    const device = await emulator(version); t.after(device.close);
    const client = new DeviceClient(device.settings); t.after(() => client.stop());
    device.writeStatus = version === 'v1' ? 202 : 200; device.configDelay = 100;
    await client.brightness('displayBrightness', 10);
    assert.equal(device.config.displayBrightness, 10); assert.equal(device.config.ledBarBrightness, 40);
    assert.equal(device.config.mqttBrokerUrl, 'mqtt://secret');
    assert.deepEqual(device.requests.find(r => r.method === 'PUT').body, { displayBrightness: 10 });
    await client.brightness('displayBrightness', 50); assert.equal(device.config.displayBrightness, 50);
    device.writeStatus = 403; await assert.rejects(client.brightness('displayBrightness', 25));
    assert.equal(device.config.displayBrightness, 50);
    device.writeStatus = 200; await client.brightness('displayBrightness', 25);
    assert.equal(device.config.displayBrightness, 25);
    device.config.configurationControl = 'cloud'; const writes = device.requests.filter(r => r.method === 'PUT').length;
    await assert.rejects(client.brightness('displayBrightness', 20), /permit local/);
    assert.equal(device.requests.filter(r => r.method === 'PUT').length, writes);
    device.config.configurationControl = 'local'; delete device.config.ledBarBrightness;
    await assert.rejects(client.brightness('ledBarBrightness', 1), /support/);
    await assert.rejects(client.brightness('displayBrightness', 101), /integer/);
    device.applyWrite = false; await assert.rejects(client.brightness('displayBrightness', 20), /did not confirm/);
  });
}

test('HTTP authentication errors, malformed data and timeouts never trigger legacy fallback', async t => {
  const device = await emulator('v1'); t.after(device.close);
  for (const status of [401, 403, 500]) {
    device.status = status; device.requests = [];
    const client = new DeviceClient(device.settings);
    await assert.rejects(client.measures()); client.stop();
    assert.equal(device.requests.length, 1);
  }
  device.status = 200;
  for (const payload of ['not json', [], {}, { hello: 'world' }]) {
    device.payload = payload; const client = new DeviceClient(device.settings);
    await assert.rejects(client.measures()); client.stop();
  }
  device.delay = 300; const client = new DeviceClient({ ...device.settings, requestTimeout: 100 });
  await assert.rejects(client.measures()); client.stop();
});

test('shutdown cancels pending requests and rejects subsequent operations', async t => {
  const device = await emulator('v1'); t.after(device.close); device.delay = 200;
  const client = new DeviceClient(device.settings); const pending = client.measures(); client.stop();
  await assert.rejects(pending); await assert.rejects(client.measures(), /stopped/);
});

test('configuration fails closed and preserves intentional empty config and first duplicate', () => {
  for (const input of [undefined, null, {}, [null], [{}], [{ serialno: 'a/b' }], [{ serialno: 'ok', port: '80' }],
    [{ serialno: 'ok', pollingInterval: 0 }], [{ serialno: 'ok', pollingInterval: '1000' }],
    [{ serialno: 'ok', offlineAfterFailures: 1.5 }], [{ serialno: 'ok', historyDays: -1 }],
    [{ serialno: 'ok', co2AlertThreshold: 800, co2ClearThreshold: 900 }],
    [{ serialno: 'ok', enableDisplayControls: 'false' }], [{ serialno: 'ok', host: 'host/path' }],
    [{ serialno: 'ok', apiVersion: 'future' }]]) { assert.throws(() => validateSensors(input)); }
  assert.deepEqual(validateSensors([]), []);
  assert.equal(validateSensors([{ serialno: 1234 }])[0].serialno, '1234');
  assert.equal(validateSensors([{ serialno: 'ABC', port: 80 }, { serialno: 'abc', port: 90 }])[0].port, 80);
  assert.equal(baseUrl({ serialno: 'ab', host: '::1', port: 81 }), 'http://[::1]:81');
  for (const host of ['http://localhost', 'user:pass@localhost', 'localhost/path', 'localhost?x']) {
    assert.throws(() => baseUrl({ serialno: 'ab', host }));
  }
  assert.equal(normalize({ serialNumber: 'ABC', temperature: 5 }, 'abc', 'v1').atmp, 5);
});

test('CO2 hysteresis, duration, threshold noise and interrupted observations', () => {
  const alert = new Co2Alert(800, 750, 1000);
  assert.equal(alert.update(850, 0), 0); assert.equal(alert.update(850, 999), 0);
  assert.equal(alert.update(850, 1000), 1); assert.equal(alert.update(790, 1100), 1);
  assert.equal(alert.update(750, 1200), 0); alert.update(850, 1300); alert.unavailable();
  assert.equal(alert.update(850, 5000), 0); assert.equal(alert.update(850, 6000), 1);
});

test('discovery records use advertised host and port, never create configuration', () => {
  assert.deepEqual(discoveryRecord({ host: 'monitor.local.', port: 8080,
    txt: { serialno: 'abc123', model: 'ONE', fw_ver: '3.1.9' } }),
  { serialno: 'abc123', host: 'monitor.local', port: 8080, model: 'ONE', firmware: '3.1.9' });
  assert.equal(discoveryRecord({ host: 'x', port: 80, txt: {} }), undefined);
});

test('real multicast discovery finds an emulated advertisement and releases its socket', async () => {
  const { Bonjour } = require('bonjour-service'); const bonjour = new Bonjour();
  const service = bonjour.publish({ name: 'AirGradient emulator', type: 'airgradient', port: 8123,
    host: 'emulator.local', txt: { serialno: 'emulated123', model: 'P-1PSG', fw_ver: '1.2.3', api: '1' } });
  try {
    const devices = await discover(2200);
    assert(devices.some(device => device.serialno === 'emulated123' && device.port === 8123));
  } finally { service.stop(); bonjour.destroy(); }
});

test('auto API selection recovers from a firmware API change; forced mode stays explicit', async t => {
  const device = await emulator('legacy'); t.after(device.close);
  const client = new DeviceClient(device.settings); t.after(() => client.stop());
  await client.measures(); assert.equal(client.version, 'legacy');
  device.version = 'v1'; device.payload = { serialNumber: 'abc123', co2: 700 };
  assert.equal((await client.measures()).rco2, 700); assert.equal(client.version, 'v1');
  device.version = 'legacy'; device.payload = { serialno: 'abc123', rco2: 650 };
  assert.equal((await client.measures()).rco2, 650); assert.equal(client.version, 'legacy');
  const forced = new DeviceClient({ ...device.settings, apiVersion: 'v1' });
  await assert.rejects(forced.measures()); forced.stop();
});
