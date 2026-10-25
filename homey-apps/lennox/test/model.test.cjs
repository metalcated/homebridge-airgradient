'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateHost, normalizeZone, candidate, planCommand, limits, resolveAdjustment } = require('../lib/model');

function fixture(overrides = {}) {
  const system = { serialNumber: 'EMU-S40-001', name: 'Main system', singleSetpointMode: false,
    hasTemperatureDeadband: true, hspCspSeparation: 3, hspCCspCSeparation: 1.5, manualAwayMode: false, getAwayMode: () => false };
  const zone = { id: 0, name: 'Living Room', temperatureC: 22, temperature: 72, humidity: 43,
    temperatureStatus: 'good', humidityStatus: 'good', systemMode: 'heat and cool', tempOperation: 'off', fanMode: 'auto',
    hspC: 20, hsp: 68, cspC: 25, csp: 77, spC: 22, sp: 72,
    heatingOption: true, coolingOption: true, minHspC: 10, maxHspC: 32, minCspC: 15.5, maxCspC: 35,
    isZoneDisabled: false, isZoneActive: () => true,
    getManualModeScheduleId: () => 16, getAwayModeScheduleId: () => 3, ...overrides };
  return { system, zone };
}

function period(plan) {
  return plan.data.schedules[0].schedule.periods[0].period;
}

test('pairing accepts an explicit local IP address or hostname', () => {
  for (const host of ['192.168.20.40', '10.0.0.8', 'thermostat.local', 'lennox-controller']) {
    assert.equal(validateHost(host), host);
  }
});

test('pairing rejects URLs, credentials, paths, ports, and malformed host values', () => {
  for (const host of [
    '', null, undefined, 1234, {}, [],
    'https://192.168.20.40', 'http://thermostat.local',
    '192.168.20.40:8080', 'user:password@thermostat.local',
    'thermostat.local/Endpoints/Connect', 'thermostat.local?query=value',
    'thermostat.local#fragment', 'thermostat local',
    '-thermostat.local', 'thermostat-.local', 'thermostat..local',
  ]) {
    assert.throws(() => validateHost(host), `Unexpectedly accepted ${String(host)}`);
  }
});

test('normalization preserves Celsius readings and translates thermostat state without inventing an automatic target', () => {
  const { system, zone } = fixture();
  assert.deepEqual(normalizeZone(system, zone), {
    measure_temperature: 22, measure_humidity: 43, thermostat_mode: 'auto',
    heat_target: 20, cool_target: 25, hvac_state: 'idle', fan_mode: 'auto',
    'target_temperature.heat': 20, 'target_temperature.cool': 25,
    'measure_temperature.heat': 22, 'measure_temperature.cool': 22,
    'thermostat_mode.heat': 'heat', 'thermostat_mode.cool': 'cool',
    target_temperature: null,
  });
  zone.systemMode = 'heat';
  zone.tempOperation = 'heating';
  assert.equal(normalizeZone(system, zone).target_temperature, 20);
  assert.equal(normalizeZone(system, zone).hvac_state, 'heating');
  zone.systemMode = 'cool';
  zone.tempOperation = 'cooling';
  assert.equal(normalizeZone(system, zone).target_temperature, 25);
  assert.equal(normalizeZone(system, zone).hvac_state, 'cooling');
});

test('native heat/cool groups mirror Celsius readings and enable only the directions allowed by the main mode', () => {
  const { system, zone } = fixture();
  for (const [mode, heatMode, coolMode] of [
    ['heat', 'heat', 'off'], ['cool', 'off', 'cool'], ['heat and cool', 'heat', 'cool'],
    ['off', 'off', 'off'], ['future-mode', 'off', 'off'],
  ]) {
    zone.systemMode = mode;
    const state = normalizeZone(system, zone);
    assert.equal(state['target_temperature.heat'], state.heat_target);
    assert.equal(state['target_temperature.cool'], state.cool_target);
    assert.equal(state['measure_temperature.heat'], state.measure_temperature);
    assert.equal(state['measure_temperature.cool'], state.measure_temperature);
    assert.equal(state['thermostat_mode.heat'], heatMode);
    assert.equal(state['thermostat_mode.cool'], coolMode);
  }
  zone.temperatureC = null;
  zone.temperature = 77;
  assert.equal(normalizeZone(system, zone)['measure_temperature.heat'], 25);
  zone.temperatureStatus = 'not_available';
  assert.equal('measure_temperature.heat' in normalizeZone(system, zone), false);
  assert.equal('measure_temperature.cool' in normalizeZone(system, zone), false);
});

test('explicitly unsupported directions request a UI override while partial metadata preserves existing control options', () => {
  const { system, zone } = fixture({ systemMode: 'heat', temperatureC: 23, cspC: 22, coolingOption: false });
  const state = normalizeZone(system, zone);
  assert.equal(state['thermostat_mode.cool'], 'off');
  assert.equal(state['measure_temperature.cool'], 23);
  const device = candidate(system, zone, 'thermostat.local');
  assert.equal(device.capabilities.includes('target_temperature.cool'), false);
  assert.equal(device.capabilitiesOptions['target_temperature.cool'].uiComponent, null);
  assert.equal(device.capabilitiesOptions['target_temperature.heat'].uiComponent, 'thermostat');
  zone.coolingOption = undefined;
  const partial = candidate(system, zone, 'thermostat.local');
  assert.notEqual(partial.capabilitiesOptions['target_temperature.cool']?.uiComponent, null,
    'Missing equipment metadata alone must not request suppression of a previously supported dial');
});

test('valid room temperature refreshes native measurement companions even when target data is temporarily absent', () => {
  const { system, zone } = fixture({ temperatureC: 23, hspC: null, hsp: null, cspC: null, csp: null });
  const state = normalizeZone(system, zone);
  assert.equal(state.measure_temperature, 23);
  assert.equal(state['measure_temperature.heat'], 23);
  assert.equal(state['measure_temperature.cool'], 23);
  assert.equal('target_temperature.heat' in state, false);
  assert.equal('target_temperature.cool' in state, false);
  zone.systemMode = 'future-mode';
  const unknown = normalizeZone(system, zone);
  assert.equal(unknown['thermostat_mode.heat'], 'off');
  assert.equal(unknown['thermostat_mode.cool'], 'off');
});

test('normalization retains zero readings, converts Fahrenheit fallback, and excludes invalid sensor values', () => {
  const { system, zone } = fixture({ temperatureC: 0, humidity: 0 });
  assert.equal(normalizeZone(system, zone).measure_temperature, 0);
  assert.equal(normalizeZone(system, zone).measure_humidity, 0);
  zone.temperatureC = null;
  zone.temperature = 77;
  assert.equal(normalizeZone(system, zone).measure_temperature, 25);
  for (const invalid of [NaN, Infinity, -Infinity, '22', null, undefined, 101, -41]) {
    zone.temperatureC = invalid;
    zone.temperature = null;
    assert.equal('measure_temperature' in normalizeZone(system, zone), false);
  }
  zone.temperatureC = 22;
  zone.temperatureStatus = 'error';
  zone.humidityStatus = 'error';
  assert.equal('measure_temperature' in normalizeZone(system, zone), false);
  assert.equal('measure_humidity' in normalizeZone(system, zone), false);
});

test('unavailable or nonexistent sensor statuses suppress old numeric readings', () => {
  const { system, zone } = fixture();
  for (const status of ['not_available', 'not_exist', 'error', 'future-status']) {
    zone.temperatureStatus = status;
    zone.humidityStatus = status;
    const state = normalizeZone(system, zone);
    assert.equal('measure_temperature' in state, false, `Temperature must not trust status ${status}`);
    assert.equal('measure_humidity' in state, false, `Humidity must not trust status ${status}`);
  }
  zone.temperatureStatus = 'good';
  zone.humidityStatus = 'good';
  assert.equal(normalizeZone(system, zone).measure_temperature, 22);
  assert.equal(normalizeZone(system, zone).measure_humidity, 43);
});

test('unknown operating modes and fan states stay unknown instead of displaying a valid-looking control state', () => {
  const { system, zone } = fixture({ systemMode: 'future-mode', fanMode: 'future-fan', tempOperation: 'future-operation', humidity: 150 });
  const state = normalizeZone(system, zone);
  assert.equal('thermostat_mode' in state, false);
  assert.equal('fan_mode' in state, false);
  assert.equal('measure_humidity' in state, false);
  assert.equal(state.hvac_state, 'unknown');
});

test('pairing identity survives IP changes and keeps different zones distinct', () => {
  const { system, zone } = fixture();
  const original = candidate(system, zone, '192.168.20.40');
  const moved = candidate(system, zone, '192.168.20.41');
  assert.deepEqual(original.data, moved.data);
  assert.notDeepEqual(original.settings, moved.settings);
  assert.deepEqual(original.store, { serial: 'EMU-S40-001', zoneId: 0 });
  assert.equal(original.settings.read_only, true);
  zone.id = 1;
  assert.notDeepEqual(original.data, candidate(system, zone, '192.168.20.40').data);
  system.serialNumber = null;
  assert.throws(() => candidate(system, zone, '192.168.20.40'), /identity/);
});

test('automatic dual-setpoint pairing exposes independently bounded heat and cool controls', () => {
  const { system, zone } = fixture();
  const device = candidate(system, zone, '192.168.20.40');
  assert.ok(device.capabilities.includes('heat_target'));
  assert.ok(device.capabilities.includes('cool_target'));
  assert.equal(device.capabilities.includes('target_temperature'), false);
  assert.deepEqual(device.capabilitiesOptions.heat_target, { min: 10, max: 23.5, step: 0.5 });
  assert.deepEqual(device.capabilitiesOptions.cool_target, { min: 21.5, max: 35, step: 0.5 });
  for (const type of ['heat', 'cool']) {
    for (const prefix of ['target_temperature', 'measure_temperature', 'thermostat_mode']) {
      assert.ok(device.capabilities.includes(`${prefix}.${type}`));
    }
    assert.equal(device.capabilitiesOptions[`target_temperature.${type}`].uiComponent, 'thermostat');
    assert.deepEqual(device.capabilitiesOptions[`measure_temperature.${type}`],
      { uiComponent: null, preventInsights: true, preventTag: true,
        title: { en: type === 'heat' ? 'Heating temperature' : 'Cooling temperature' } });
    assert.deepEqual(device.capabilitiesOptions[`thermostat_mode.${type}`],
      { uiComponent: null, preventInsights: true, preventTag: true });
  }
  assert.equal(device.capabilitiesOptions.target_temperature.uiComponent, null, 'The app requests a UI override for a retained scalar capability; native core grouping can still retain its dial');
  zone.coolingOption = false;
  const heatOnly = candidate(system, zone, '192.168.20.40');
  assert.deepEqual(heatOnly.capabilitiesOptions.thermostat_mode.values.map(value => value.id), ['off', 'heat']);
  assert.equal(heatOnly.capabilities.includes('cool_target'), false);
  assert.equal(heatOnly.capabilities.includes('target_temperature.cool'), false);
});

test('known modes authoritatively select only their native targets and relative adjustment buttons', () => {
  const { system, zone } = fixture();
  for (const [mode, active] of [['heat', ['heat']], ['cool', ['cool']], ['heat and cool', ['heat', 'cool']], ['off', []]]) {
    zone.systemMode = mode;
    const device = candidate(system, zone, 'thermostat.local');
    assert.deepEqual([...device.nativeTargets].sort(), active.map(type => `target_temperature.${type}`).sort());
    assert.deepEqual(device.capabilities.filter(id => /^target_temperature\.(heat|cool)$/.test(id)).sort(), [...device.nativeTargets].sort());
    assert.deepEqual([...device.adjustments].sort(), active.flatMap(type => [`${type}_decrease`, `${type}_increase`]).sort());
  }
  zone.systemMode = 'future-mode';
  assert.equal(candidate(system, zone, 'thermostat.local').nativeTargets, undefined);
  assert.equal(candidate(system, zone, 'thermostat.local').adjustments, undefined);
  system.singleSetpointMode = true;
  zone.systemMode = 'heat and cool';
  const single = candidate(system, zone, 'thermostat.local');
  assert.deepEqual(single.nativeTargets, []);
  assert.deepEqual([...single.adjustments].sort(), ['target_decrease', 'target_increase']);
  zone.systemMode = 'off';
  assert.deepEqual(candidate(system, zone, 'thermostat.local').adjustments, []);
});

test('relative targets use the fresh current value and preserve one Fahrenheit or half-Celsius increments', () => {
  const { system, zone } = fixture({ hsp: 73, hspC: 23, csp: 85, cspC: 29.5 });
  const imperial = resolveAdjustment(system, zone, { type: 'adjust', target: 'heat', direction: 1, units: 'imperial' });
  assert.equal(imperial.type, 'heat');
  assert.equal(imperial.units, 'imperial');
  const imperialPlan = planCommand(system, zone, imperial);
  assert.equal(period(imperialPlan).hsp, 74);
  assert.equal(imperialPlan.temperature.units, 'imperial');
  const metric = resolveAdjustment(system, zone, { type: 'adjust', target: 'heat', direction: -1, units: 'metric' });
  assert.equal(metric.units, 'metric');
  assert.equal(period(planCommand(system, zone, metric)).hspC, 22.5);
  assert.equal(planCommand(system, zone, { type: 'heat', value: 22.5 }).temperature.units, 'metric', 'Legacy Flow values retain their Celsius confirmation contract');
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 22.5, units: 'unknown' }), /units/);
  for (const malformed of [
    { target: 'heat', direction: 0, units: 'metric' }, { target: 'heat', direction: 2, units: 'metric' },
    { target: 'heat', direction: true, units: 'metric' }, { target: 'heat', direction: 1, units: 'unknown' },
    { target: 'humidity', direction: 1, units: 'metric' },
  ]) assert.throws(() => resolveAdjustment(system, zone, { type: 'adjust', ...malformed }));
});

test('coalesced relative adjustments apply a validated step count to the current unit value and preserve the opposite target', () => {
  const { system, zone } = fixture({ systemMode: 'heat', hsp: 73, hspC: 23, csp: 85, cspC: 29.5 });
  for (const [units, direction, steps, expectedC, expectedF] of [
    ['imperial', 1, 3, 24.5, 76], ['imperial', -1, 2, 21.5, 71],
    ['metric', 1, 3, 24.5, 76], ['metric', -1, 2, 22, 72],
  ]) {
    const resolved = resolveAdjustment(system, zone, { type: 'adjust', target: 'heat', direction, units, steps });
    assert.deepEqual(period(planCommand(system, zone, resolved)), { hspC: expectedC, hsp: expectedF });
    assert.equal(zone.hsp, 73, 'Planning must use the observed state without optimistically mutating it');
    assert.equal(zone.csp, 85);
  }
  zone.hsp = 74;
  zone.hspC = 23.5;
  assert.equal(period(planCommand(system, zone, resolveAdjustment(system, zone,
    { type: 'adjust', target: 'heat', direction: 1, units: 'imperial', steps: 3 }))).hsp, 77, 'A later batch must derive its destination from the new actual state');
  for (const steps of [0, -1, 1.5, 21, '3', true, null, NaN]) {
    assert.throws(() => resolveAdjustment(system, zone, { type: 'adjust', target: 'heat', direction: 1, units: 'imperial', steps }));
  }
  const maximum = resolveAdjustment(system, zone, { type: 'adjust', target: 'heat', direction: -1, units: 'imperial', steps: 20 });
  assert.equal(period(planCommand(system, zone, maximum)).hsp, 54);
});

test('reported deadband constrains both target ranges and each boundary remains safe after rounding', () => {
  const { system, zone } = fixture({ temperatureDeadbandC: 2 });
  const device = candidate(system, zone, 'thermostat.local');
  assert.equal(device.capabilitiesOptions['target_temperature.heat'].max, 23);
  assert.equal(device.capabilitiesOptions['target_temperature.cool'].min, 22);
  assert.equal(period(planCommand(system, zone, { type: 'heat', value: 23 })).hspC, 23);
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5 }), /limit|separation/);
  assert.equal(period(planCommand(system, zone, { type: 'cool', value: 22 })).cspC, 22);
  assert.throws(() => planCommand(system, zone, { type: 'cool', value: 21.5 }), /limit|separation/);
  for (const noise of [-1e-10, 1e-10]) {
    assert.equal(period(planCommand(system, zone, { type: 'heat', value: 23 + noise })).hspC, 23);
  }
  zone.cspC = 23;
  zone.csp = 73;
  const narrowed = candidate(system, zone, 'thermostat.local');
  assert.ok(narrowed.capabilitiesOptions['target_temperature.heat'].max <= 21);
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21.5 }), /separation/);
});

test('active single-direction controls mirror native inactive-target shifts while Automatic and inactive controls remain independent', () => {
  const { system, zone } = fixture({ hsp: 72, hspC: 22, csp: 76, cspC: 24.5 });
  system.hspCspSeparation = 4;
  system.hspCCspCSeparation = 2;
  zone.systemMode = 'heat';
  assert.deepEqual(period(planCommand(system, zone, { type: 'heat', value: 23.5 })), { hspC: 23.5, hsp: 74, cspC: 25.5, csp: 78 });
  assert.throws(() => planCommand(system, zone, { type: 'cool', value: 23.5 }), /separation|inactive/i);
  zone.systemMode = 'cool';
  assert.deepEqual(period(planCommand(system, zone, { type: 'cool', value: 23.5 })), { cspC: 23.5, csp: 74, hspC: 21, hsp: 70 });
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5 }), /separation|inactive/i);
  zone.systemMode = 'off';
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5 }), /separation/i);
  assert.equal(zone.hsp, 72);
  assert.equal(zone.csp, 76);
  zone.systemMode = 'heat';
  assert.equal(candidate(system, zone, 'thermostat.local').capabilitiesOptions['target_temperature.heat'].max, 32);
  zone.systemMode = 'cool';
  assert.equal(candidate(system, zone, 'thermostat.local').capabilitiesOptions['target_temperature.cool'].min, 15.5);
  zone.systemMode = 'heat and cool';
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5 }), /separation/);
  assert.throws(() => planCommand(system, zone, { type: 'cool', value: 23.5 }), /separation/);
});

test('entering Automatic validates existing dual targets without moving them and native shifts require an actual reported gap', () => {
  const { system, zone } = fixture({ systemMode: 'heat', hsp: 74, hspC: 23.5, csp: 76, cspC: 24.5 });
  system.hspCspSeparation = 4;
  system.hspCCspCSeparation = 2;
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'auto' }), /Automatic mode.*separated/);
  assert.equal(zone.hsp, 74);
  assert.equal(zone.csp, 76);
  zone.csp = 78;
  zone.cspC = 25.5;
  assert.deepEqual(period(planCommand(system, zone, { type: 'mode', value: 'auto' })), { systemMode: 'heat and cool' });
  system.hspCspSeparation = null;
  system.hspCCspCSeparation = null;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 24 }), /separation.*unknown|reported/i);
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'auto' }), /separation is unknown/);
  system.singleSetpointMode = true;
  assert.deepEqual(period(planCommand(system, zone, { type: 'mode', value: 'auto' })), { systemMode: 'heat and cool' });
});

test('native inactive-target synthesis honors each reported gap and both hardware grids without weakening metric Flows or Automatic', () => {
  for (let gapF = 3; gapF <= 9; gapF++) {
    for (const units of ['imperial', 'metric']) {
      const { system, zone } = fixture({ systemMode: 'heat', hsp: 73, hspC: 23, csp: 76, cspC: 24.5,
        minCsp: 60, maxCsp: 95 });
      system.hspCspSeparation = gapF;
      system.hspCCspCSeparation = Math.round(gapF * 5 / 9 * 2) / 2;
      const plan = planCommand(system, zone, { type: 'heat', value: 26.5, units });
      const update = period(plan);
      assert.equal(update.hsp, 80);
      assert.equal(update.hspC, 26.5);
      assert.ok(update.csp >= 80 + gapF && update.csp <= zone.maxCsp);
      assert.ok(update.cspC >= 26.5 + system.hspCCspCSeparation && update.cspC <= zone.maxCspC);
      assert.equal(Math.round(update.cspC * 9 / 5 + 32), update.csp);
      assert.equal(update.cspC * 2, Math.round(update.cspC * 2));
      assert.deepEqual(plan.temperatures.map(target => target.key), ['hsp', 'csp']);
      assert.ok(plan.temperatures.every(target => target.units === units));
      assert.deepEqual(Object.keys(update).sort(), ['csp', 'cspC', 'hsp', 'hspC']);
      assert.equal(zone.csp, 76, 'Planning must not optimistically mutate observed targets');
    }
  }
  for (const bounds of [{ maxCspC: 24.5 }, { maxCsp: 76 }]) {
    const { system, zone } = fixture({ systemMode: 'heat', hsp: 73, hspC: 23, csp: 76, cspC: 24.5, ...bounds });
    assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5, units: 'imperial' }), /limits|smaller/);
  }
  for (const bounds of [{ minHspC: 22.5 }, { minHsp: 73 }]) {
    const { system, zone } = fixture({ systemMode: 'cool', hsp: 73, hspC: 23, csp: 76, cspC: 24.5, ...bounds });
    assert.throws(() => planCommand(system, zone, { type: 'cool', value: 24, units: 'imperial' }), /limits|smaller/);
  }
  const { system, zone } = fixture({ systemMode: 'heat', hsp: 73, hspC: 23, csp: 76, cspC: 24.5 });
  system.hasTemperatureDeadband = false;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5 }), /reported|unknown/i);
  zone.temperatureDeadbandC = 1.5;
  assert.equal(period(planCommand(system, zone, { type: 'heat', value: 23.5 })).csp, 77);
  zone.systemMode = 'heat and cool';
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 23.5 }), /separation/);
});

test('missing thermostat limits retain readings but do not expose an unbounded write control', () => {
  const { system, zone } = fixture({ minHspC: null, minHsp: null, maxHspC: null, maxHsp: null });
  const device = candidate(system, zone, '192.168.20.40');
  assert.ok(device.capabilities.includes('measure_temperature'));
  assert.equal(device.capabilities.includes('heat_target'), false);
  assert.throws(() => limits(zone, 'heat'), /limits/);
});

test('temperature writes change only the requested setpoint and require observed readback', () => {
  const { system, zone } = fixture();
  const heat = planCommand(system, zone, { type: 'heat', value: 21.2 });
  assert.deepEqual(period(heat), { hspC: 21, hsp: 70 });
  assert.equal(heat.expectedKey, 'heat_target');
  assert.equal(heat.expectedValue, 21);
  assert.equal(heat.data.schedules[0].id, 16);
  assert.deepEqual(period(planCommand(system, zone, { type: 'cool', value: 24.5 })), { cspC: 24.5, csp: 76 });
  assert.equal(zone.hspC, 20, 'Planning must not optimistically alter the observed thermostat state');
  assert.equal(zone.cspC, 25);
});

test('mode and fan commands avoid overwriting humidity, setpoints, and unrelated period fields', () => {
  const { system, zone } = fixture();
  const mode = planCommand(system, zone, { type: 'mode', value: 'auto' });
  assert.deepEqual(period(mode), { systemMode: 'heat and cool' });
  assert.equal(mode.expectedKey, 'thermostat_mode');
  assert.equal(mode.expectedValue, 'auto');
  const fan = planCommand(system, zone, { type: 'fan', value: 'circulate' });
  assert.deepEqual(period(fan), { fanMode: 'circulate' });
  assert.equal(fan.expectedKey, 'fan_mode');
});

test('writes reject invalid targets, unsupported equipment, disabled zones, and deadband crossings', () => {
  const { system, zone } = fixture();
  for (const value of [NaN, Infinity, '21', null, undefined, 9, 33]) {
    assert.throws(() => planCommand(system, zone, { type: 'heat', value }));
  }
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 24 }), /separation/);
  assert.throws(() => planCommand(system, zone, { type: 'cool', value: 21 }), /separation/);
  assert.throws(() => planCommand(system, zone, { type: 'target', value: 22 }), /separate/);
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'emergency heat' }), /Unsupported/);
  assert.throws(() => planCommand(system, zone, { type: 'fan', value: 'turbo' }), /Unsupported/);
  assert.throws(() => planCommand(system, zone, { type: 'humidity', value: 50 }), /Unsupported/);
  zone.heatingOption = false;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21 }), /not supported/);
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'heat' }), /not supported/);
  zone.coolingOption = false;
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'cool' }), /not supported/);
  zone.isZoneDisabled = true;
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'off' }), /disabled/);
});

test('single-setpoint commands use sp exclusively and enforce the shared operating limits', () => {
  const { system, zone } = fixture();
  system.singleSetpointMode = true;
  const command = planCommand(system, zone, { type: 'target', value: 23 });
  assert.deepEqual(period(command), { spC: 23, sp: 73 });
  assert.equal(command.expectedKey, 'target_temperature');
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21 }), /single temperature/);
  assert.throws(() => planCommand(system, zone, { type: 'cool', value: 25 }), /single temperature/);
  assert.throws(() => planCommand(system, zone, { type: 'target', value: 12 }), /limits/);
  const device = candidate(system, zone, '192.168.20.40');
  assert.ok(device.capabilities.includes('target_temperature'));
  assert.equal(device.capabilities.includes('heat_target'), false);
  assert.equal(device.capabilities.includes('cool_target'), false);
  assert.equal(device.capabilitiesOptions.target_temperature.uiComponent, 'thermostat');
  assert.equal(device.capabilitiesOptions['target_temperature.heat'].uiComponent, null);
  assert.equal(device.capabilitiesOptions['target_temperature.cool'].uiComponent, null);
  const state = normalizeZone(system, zone);
  assert.equal(state['thermostat_mode.heat'], 'off');
  assert.equal(state['thermostat_mode.cool'], 'off');
  assert.equal(state['measure_temperature.heat'], state.measure_temperature);
  assert.equal(state['measure_temperature.cool'], state.measure_temperature);
  assert.equal('target_temperature.heat' in state, false, 'SSP reports must not overwrite an old independent target');
  assert.equal('target_temperature.cool' in state, false);
  assert.equal(device.capabilities.includes('measure_temperature.heat'), false, 'A new SSP device must not gain unused native companion groups');
  assert.equal(device.capabilities.includes('measure_temperature.cool'), false);
});

test('Away and thermostat-denied local access reject writes without targeting a shared schedule', () => {
  const { system, zone } = fixture();
  system.manualAwayMode = true;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21 }), /Away.*shared/);
  system.manualAwayMode = false;
  system.getAwayMode = () => true;
  assert.throws(() => planCommand(system, zone, { type: 'mode', value: 'off' }), /Away/);
  system.getAwayMode = () => false;
  for (const access of ['readOnly', 'closed', null]) {
    zone.localWriteAccess = access;
    assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21 }), /local write access/);
  }
  zone.localWriteAccess = 'openAll';
  assert.deepEqual(period(planCommand(system, zone, { type: 'heat', value: 21 })), { hspC: 21, hsp: 70 });
});

test('an active nonmanual schedule cannot be silently replaced by a Homey command', () => {
  const { system, zone } = fixture({ scheduleId: 0 });
  for (const command of [{ type: 'heat', value: 21 }, { type: 'mode', value: 'off' }, { type: 'fan', value: 'on' }]) {
    assert.throws(() => planCommand(system, zone, command), /Manual mode.*not replace an active schedule/);
  }
  zone.scheduleId = 16;
  assert.equal(planCommand(system, zone, { type: 'heat', value: 21 }).data.schedules[0].id, 16);
  zone.id = 1;
  zone.getManualModeScheduleId = () => 17;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21 }), /Manual mode/);
  zone.scheduleId = 17;
  assert.equal(planCommand(system, zone, { type: 'heat', value: 21 }).data.schedules[0].id, 17);
});

test('reported per-zone deadband and raw/rounded thermostat limits all constrain writes', () => {
  const { system, zone } = fixture({ temperatureDeadbandC: 4 });
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 22 }), /separation/);
  assert.throws(() => planCommand(system, zone, { type: 'cool', value: 23 }), /separation/);
  zone.temperatureDeadbandC = 2;
  assert.deepEqual(period(planCommand(system, zone, { type: 'heat', value: 22 })), { hspC: 22, hsp: 72 });
  zone.maxHspC = 21.3;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21.3 }), /Rounded temperature/);
  zone.maxHspC = 32;
  zone.minHspC = 20.2;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 20.2 }), /Rounded temperature/);
  zone.minHspC = 10;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 9.9 }), /outside the thermostat limits/);
  zone.temperatureDeadbandC = 0;
  assert.throws(() => planCommand(system, zone, { type: 'heat', value: 21 }), /separation is unknown/);
});

test('whole-Fahrenheit hardware endpoints survive Celsius conversion while metric raw limits and both native bounds remain enforced', () => {
  for (const type of ['heat', 'cool', 'target']) {
    const { system, zone } = fixture({ systemMode: type === 'cool' ? 'cool' : 'heat',
      minHspC: 4.5, minHsp: 40, maxHspC: 32, maxHsp: 90,
      minCspC: 4.5, minCsp: 40, maxCspC: 32, maxCsp: 90 });
    system.singleSetpointMode = type === 'target';
    if (type === 'heat') zone.coolingOption = false;
    if (type === 'cool') zone.heatingOption = false;
    const key = { heat: 'hsp', cool: 'csp', target: 'sp' }[type];
    for (const [fahrenheit, celsius] of [[40, 4.5], [90, 32]]) {
      const plan = planCommand(system, zone, { type, value: (fahrenheit - 32) * 5 / 9, units: 'imperial' });
      assert.deepEqual(period(plan), { [key + 'C']: celsius, [key]: fahrenheit });
    }
    for (const fahrenheit of [39, 91]) {
      assert.throws(() => planCommand(system, zone, { type, value: (fahrenheit - 32) * 5 / 9, units: 'imperial' }), /limits/);
    }
    for (const value of [4.44, 32.22]) {
      assert.throws(() => planCommand(system, zone, { type, value, units: 'metric' }), /limits/);
    }
    zone.minHspC = zone.minCspC = 4.6;
    assert.throws(() => planCommand(system, zone, { type, value: (40 - 32) * 5 / 9, units: 'imperial' }), /Rounded temperature/);
    zone.minHspC = zone.minCspC = 4.5;
    zone.minHsp = zone.minCsp = 41;
    assert.throws(() => planCommand(system, zone, { type, value: (40 - 32) * 5 / 9, units: 'imperial' }), /Fahrenheit limits/);
  }
});
