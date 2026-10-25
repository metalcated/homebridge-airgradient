'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { IdentityTracker } = require('../lib/identity');

// Synthesized values with the released upstream fixture field shapes. No real
// thermostat identifiers or copied household/device records are present.
const feature = (id, fid, value, name) => ({ id, feature: { fid, ...(name ? { name } : {}), values: [{ id: 0, value }] } });
const thermostat = (id, value, extras = {}) => ({ id, device: { deviceType: 500, features: [feature(1, 9, value, 'control serial number')], ...extras } });
const peripheral = (id, type, value) => ({ id, device: { deviceType: type, serialNumber: value, features: [feature(1, 9, value)] } });
const equipment = (serial, type = 'S40', equipmentType = 'System') => ({ id: 0, equipment: { features: [feature(1, 32773, type, 'Product Type'), feature(3, 15, equipmentType, 'Equipment Type Name'), feature(6, 9, serial, 'Control Serial Number')] } });

test('S30 and M30 thermostat serials are read from device type 500 feature values', () => {
  for (const productType of ['S30', 'M30']) {
    const tracker = new IdentityTracker();
    const result = tracker.update({ system: { config: { options: { productType } } }, devices: [thermostat(0, 'TEST-THERMOSTAT-01')] });
    assert.deepEqual(result, { serial: 'TEST-THERMOSTAT-01', productType });
  }
});

test('direct thermostat serials require a verified thermostat identity', () => {
  const tracker = new IdentityTracker();
  assert.deepEqual(tracker.update({ devices: [peripheral(1, 501, 'TEST-BASE'), peripheral(2, 502, 'TEST-APP-MANAGER')] }), { serial: null, productType: null });
  assert.deepEqual(tracker.update({ devices: [{ id: 0, device: { deviceType: 500, serialNumber: 'TEST-DIRECT', productType: 'E30' } }] }), { serial: 'TEST-DIRECT', productType: 'E30' });
});

test('a thermostat equipment-type feature identifies a controller when deviceType is absent', () => {
  const tracker = new IdentityTracker();
  assert.deepEqual(tracker.update({ devices: [{ id: 0, device: { features: [feature(5, 15, 'Thermostat'), feature(1, 9, 'TEST-TYPE-NAMED')] } }] }), { serial: 'TEST-TYPE-NAMED', productType: null });
});

test('peripheral updates cannot replace a thermostat serial and equipment serials are not used for S30', () => {
  const tracker = new IdentityTracker();
  tracker.update({ system: { config: { options: { productType: 'S30' } } }, devices: [thermostat(0, 'TEST-MAIN')] });
  const result = tracker.update({ devices: [peripheral(1, 501, 'TEST-BASE'), peripheral(2, 502, 'TEST-APP-MANAGER'), peripheral(3, 503, 'TEST-REMOTE')], equipments: [equipment('TEST-SYSTEM', 'S30')] });
  assert.deepEqual(result, { serial: 'TEST-MAIN', productType: 'S30' });
});

test('S40 uses equipment zero control serial with no thermostat serial feature', () => {
  const tracker = new IdentityTracker();
  assert.deepEqual(tracker.update({ equipments: [equipment('TEST-S40-SYSTEM')] }), { serial: 'TEST-S40-SYSTEM', productType: 'S40' });
  const result = tracker.update({ devices: [peripheral(1, 501, 'TEST-BASE')] });
  assert.deepEqual(result, { serial: 'TEST-S40-SYSTEM', productType: 'S40' });
});

test('S40 does not borrow a non-system equipment serial or a different equipment index', () => {
  const tracker = new IdentityTracker();
  const other = equipment('TEST-OTHER');
  other.id = 1;
  assert.deepEqual(tracker.update({ system: { config: { options: { productType: 'S40' } } }, equipments: [other, equipment('TEST-AC', 'S40', 'Air Conditioner')] }), { serial: null, productType: 'S40' });
});

test('registration serial takes precedence over device and S40 equipment identities', () => {
  const tracker = new IdentityTracker();
  assert.deepEqual(tracker.update({ system: { registration: { serialNumber: 'TEST-REGISTERED', productType: 'S40' } }, devices: [thermostat(0, 'TEST-DISPLAY')], equipments: [equipment('TEST-SYSTEM')] }), { serial: 'TEST-REGISTERED', productType: 'S40' });
});

test('device type, serial feature metadata and values may arrive in separate messages', () => {
  const tracker = new IdentityTracker();
  assert.equal(tracker.update({ devices: [{ id: 0, device: { deviceType: 500 } }] }).serial, null);
  assert.equal(tracker.update({ devices: [{ id: 0, device: { features: [{ id: 1, feature: { fid: 9, name: 'control serial number' } }] } }] }).serial, null);
  assert.equal(tracker.update({ devices: [{ id: 0, device: { features: [{ id: 1, feature: { values: [{ id: 0, value: 'TEST-FRAGMENTED' }] } }] } }] }).serial, 'TEST-FRAGMENTED');
  assert.equal(tracker.update({ devices: [{ id: 0, device: { features: [feature(3, 11, '1.2.3')] } }] }).serial, 'TEST-FRAGMENTED');
});

test('S40 equipment features merge across fragments and unrelated features preserve identity', () => {
  const tracker = new IdentityTracker();
  tracker.update({ equipments: [{ id: 0, equipment: { features: [feature(1, 32773, 'S40')] } }] });
  tracker.update({ equipments: [{ id: 0, equipment: { features: [{ id: 6, feature: { fid: 9 } }] } }] });
  const result = tracker.update({ equipments: [{ id: 0, equipment: { features: [{ id: 6, feature: { values: [{ id: 0, value: 'TEST-FRAGMENT-S40' }] } }] } }] });
  assert.deepEqual(result, { serial: 'TEST-FRAGMENT-S40', productType: 'S40' });
});

test('string numeric IDs and lowercase product types are normalized', () => {
  const tracker = new IdentityTracker();
  assert.deepEqual(tracker.update({ system: { config: { options: { productType: ' m30 ' } } }, devices: [{ id: '0', device: { deviceType: '500', features: [{ id: '1', feature: { fid: '9', values: [{ id: '0', value: ' TEST-NORMALIZED ' }] } }] } }] }), { serial: 'TEST-NORMALIZED', productType: 'M30' });
});

test('conflicting thermostat identities are rejected instead of choosing an arbitrary device', () => {
  const tracker = new IdentityTracker();
  assert.throws(() => tracker.update({ devices: [thermostat(0, 'TEST-FIRST'), thermostat(1, 'TEST-SECOND')] }), /Ambiguous Lennox thermostat serial/);
});

test('malformed identifiers and unknown model names cannot become device identities', () => {
  for (const value of [null, undefined, 123, '', '  ', 'TEST\nSERIAL', 'x'.repeat(129)]) {
    const tracker = new IdentityTracker();
    assert.deepEqual(tracker.update({ system: { registration: { serialNumber: value, productType: 'not-a-model' } }, devices: [thermostat(0, value)] }), { serial: null, productType: null });
  }
  assert.deepEqual(new IdentityTracker().update({}), { serial: null, productType: null });
});
