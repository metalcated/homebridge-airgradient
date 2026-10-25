'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { candidate, normalizeZone } = require('../lib/model');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));

function fixture(mode = 'heat and cool', temperature = 22, single = false) {
  const system = { serialNumber: 'EMU-UI-001', name: 'Emulated thermostat', singleSetpointMode: single,
    hspCCspCSeparation: 1.5, hspCspSeparation: 3 };
  const zone = { id: 0, name: 'Living room', temperatureC: temperature, humidity: 43,
    temperatureStatus: 'good', humidityStatus: 'good', systemMode: mode, tempOperation: 'off', fanMode: 'auto',
    heatingOption: true, coolingOption: true, hspC: 20, cspC: 25, spC: 22,
    minHspC: 10, maxHspC: 32, minCspC: 15.5, maxCspC: 35 };
  const metadata = candidate(system, zone, 'thermostat.local');
  const state = normalizeZone(system, zone);
  const capabilitiesObj = {};
  for (const id of metadata.capabilities) {
    const temperatureCapability = id.startsWith('target_temperature') || id.startsWith('measure_temperature');
    capabilitiesObj[id] = { id, value: state[id] ?? null, getable: true,
      setable: id.startsWith('target_temperature') || id === 'thermostat_mode',
      ...(temperatureCapability ? { units: '°C', decimals: 1 } : {}),
      ...metadata.capabilitiesOptions[id] };
  }
  return { metadata, state, device: { id: 'homey-device-id', capabilitiesObj } };
}

// Homey's documented thermostat group uses these matching capability suffixes.
// The optional integration tests below execute the deployed renderer itself.
function groupIds(selected) {
  const suffix = selected.split('.')[1];
  return ['target_temperature', 'measure_temperature', 'thermostat_mode']
    .map(prefix => suffix === undefined ? prefix : `${prefix}.${suffix}`);
}

test('legacy target capabilities retain Flow and Insights identity without claiming a native thermostat UI', () => {
  for (const type of ['heat', 'cool']) {
    const legacy = manifest.capabilities[`${type}_target`];
    assert.equal(legacy.uiComponent, null);
    assert.equal(legacy.getable, true);
    assert.equal(legacy.setable, true);
    assert.equal(legacy.insights, true);
    assert.equal(legacy.units.en, '°C');
    const action = manifest.flow.actions.find(action => action.id === `${type}_target_set`);
    assert.ok(action.args.some(argument => argument.filter?.includes(`capabilities=${type}_target`)));
    assert.equal(manifest.capabilities[`target_temperature.${type}`], undefined,
      'Native sub-capabilities must inherit the system capability contract');
  }
});

test('each dual native thermostat group resolves its target, current temperature, direction and Celsius metadata', () => {
  const { metadata, state, device } = fixture();
  for (const type of ['heat', 'cool']) {
    const ids = groupIds(`target_temperature.${type}`);
    assert.ok(ids.every(id => id in device.capabilitiesObj), `Incomplete ${type} thermostat group`);
    assert.equal(device.capabilitiesObj[ids[0]].units, '°C');
    assert.equal(device.capabilitiesObj[ids[1]].units, '°C');
    assert.equal(state[ids[0]], type === 'heat' ? 20 : 25);
    assert.equal(state[ids[1]], 22);
    assert.equal(state[ids[2]], type);
    assert.equal(metadata.capabilitiesOptions[ids[0]].uiComponent, 'thermostat');
    assert.equal(metadata.capabilitiesOptions[ids[1]].uiComponent, null);
    assert.equal(metadata.capabilitiesOptions[ids[2]].uiComponent, null);
  }
});

const reviewedBundle = process.env.HOMEY_REVIEWED_WEB_BUNDLE;
const actualRendererOptions = {
  skip: reviewedBundle ? false : 'Set HOMEY_REVIEWED_WEB_BUNDLE to execute the reviewed deployed Homey thermostat renderer',
};

function extractVendorFunctions() {
  const source = fs.readFileSync(reviewedBundle, 'utf8');
  const rendererStart = source.indexOf('function VSe(');
  const rendererEnd = source.indexOf('function OB(', rendererStart);
  const colorStart = source.indexOf('function Kz(');
  const colorEnd = source.indexOf('var Bbe=', colorStart);
  assert.ok(rendererStart >= 0 && rendererEnd > rendererStart, 'Reviewed thermostat renderer must be present');
  assert.ok(colorStart >= 0 && colorEnd > colorStart, 'Reviewed thermostat color calculation must be present');
  return source.slice(rendererStart, rendererEnd) + '\n' + source.slice(colorStart, colorEnd);
}

function renderActual(device, componentCapabilities, selected) {
  const lookups = [], writes = [], attempts = [];
  const context = vm.createContext({
    WN: () => ({ device }),
    P: { useMemo: work => work(), useState: initial => [selected ?? (typeof initial === 'function' ? initial() : initial), () => {}] },
    KI: { default: callback => callback },
    pR: ({ capabilityId }) => {
      lookups.push(capabilityId);
      const capability = device.capabilitiesObj[capabilityId];
      return [capability?.value ?? null, value => {
        attempts.push({ capabilityId, value });
        if (!capability) return Promise.reject(Error('Capability object is not available'));
        writes.push({ capabilityId, value });
        return Promise.resolve();
      }, capability ?? null];
    },
    L: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    uR: 'root', fR: 'header', lR: 'selector', dR: 'body', PSe: 'thermostat-dial',
  });
  vm.runInContext(extractVendorFunctions(), context);
  const tree = context.VSe({ deviceId: device.id, component: { capabilities: componentCapabilities } });
  const dial = tree.props.children.find(node => node.type === 'body').props.children;
  assert.equal(dial.type, 'thermostat-dial');
  return { props: dial.props, lookups, writes, attempts, color: context.Kz };
}

test('the actual renderer reproduces a null-target legacy dial and resolves each corrected native write ID', actualRendererOptions, async () => {
  const { device } = fixture();
  const oldCapabilitiesObj = Object.fromEntries(Object.entries(device.capabilitiesObj).filter(([id]) => !id.includes('.')));
  const broken = renderActual({ ...device, capabilitiesObj: oldCapabilitiesObj }, ['heat_target', 'cool_target'], 'heat_target');
  assert.equal(broken.lookups[0], null);
  assert.equal(broken.props.targetValue, null);
  broken.props.onTargetValueChange(21.5);
  await Promise.resolve();
  assert.deepEqual(broken.writes, [], 'The legacy dial cannot reach the custom target listener');
  for (const type of ['heat', 'cool']) {
    const id = `target_temperature.${type}`;
    const rendered = renderActual(device, ['target_temperature.heat', 'target_temperature.cool'], id);
    assert.deepEqual(rendered.lookups, groupIds(id));
    assert.equal(rendered.props.targetValue, type === 'heat' ? 20 : 25);
    assert.equal(rendered.props.measureValue, 22);
    assert.equal(rendered.props.modeValue, type);
    assert.equal(rendered.props.hideMeasureTemperature, false);
    assert.equal(rendered.props.units, '°C');
    assert.equal(rendered.props.step, 0.5);
    const value = type === 'heat' ? 21.5 : 24.5;
    rendered.props.onTargetValueChange(value);
    assert.deepEqual(rendered.writes, [{ capabilityId: id, value }]);
  }
});

test('actual Homey dial colors follow enabled direction and temperature boundaries rather than inventing HVAC demand', actualRendererOptions, () => {
  for (const mode of ['heat', 'cool', 'heat and cool', 'off', 'future-mode']) {
    for (const temperature of [18, 20, 22, 25, 27]) {
      const { device } = fixture(mode, temperature);
      for (const type of ['heat', 'cool']) {
        const rendered = renderActual(device, ['target_temperature.heat', 'target_temperature.cool'], `target_temperature.${type}`);
        const enabled = mode === type || mode === 'heat and cool';
        const expected = enabled && (type === 'heat' ? temperature < 20 : temperature > 25) ? type : 'off';
        assert.equal(rendered.color({ mode: rendered.props.modeValue, measure: rendered.props.measureValue,
          target: rendered.props.targetValue }), expected, `${mode}/${type}/${temperature}°C`);
      }
    }
  }
});

test('the actual single-setpoint renderer retains the native base target and Celsius write contract', actualRendererOptions, () => {
  const { device } = fixture('heat and cool', 21, true);
  const rendered = renderActual(device, ['target_temperature'], 'target_temperature');
  assert.deepEqual(rendered.lookups, groupIds('target_temperature'));
  assert.equal(rendered.props.targetValue, 22);
  assert.equal(rendered.props.measureValue, 21);
  assert.equal(rendered.props.units, '°C');
  rendered.props.onTargetValueChange(23);
  assert.deepEqual(rendered.writes, [{ capabilityId: 'target_temperature', value: 23 }]);
});
