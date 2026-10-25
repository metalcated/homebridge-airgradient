'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { BEFORE, AFTER, EXPECTED_SHA256, transformSource, patchBundle } = require('../scripts/patch-homey-13.5.3-thermostat.cjs');
const { transformSource: iconTransform } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');

const source = `function select(e){let n=e.targets,[r,i]=(0,P.useState)(()=>n[0]),a=[];return {selected:r,change:i}}`;
function render(text, targets, requested) {
  const changes = [];
  const context = vm.createContext({ P: { useState: initial => [requested ?? initial(), value => changes.push(value)] } });
  vm.runInContext(text, context);
  return { result: context.select({ targets }), changes };
}

test('optional native selection fix keeps a valid choice and replaces a removed choice on the next render', () => {
  const patched = transformSource(source);
  assert.equal(render(source, ['heat'], 'cool').result.selected, 'cool', 'Reproduce the retained invalid vendor selection');
  for (const [targets, selected, expected] of [
    [['heat'], 'cool', 'heat'], [['cool'], 'heat', 'cool'],
    [['heat', 'cool'], 'cool', 'cool'], [['heat', 'cool'], 'heat', 'heat'],
    [[], 'cool', undefined], [['heat'], undefined, 'heat'],
  ]) assert.equal(render(patched, targets, selected).result.selected, expected);
  const active = render(patched, ['heat', 'cool'], 'heat');
  active.result.change('cool');
  assert.deepEqual(active.changes, ['cool']);
});

test('optional selection transformer refuses missing, duplicate, repeated, or unreviewed bundle inputs', () => {
  assert.throws(() => transformSource(''), /found 0/);
  assert.throws(() => transformSource(source + source), /found 2/);
  assert.throws(() => transformSource(transformSource(source)), /found 0/);
  assert.throws(() => patchBundle(Buffer.from(source)), /Unsupported/);
  assert.equal(transformSource(source).split(AFTER).length - 1, 1);
  assert.equal(EXPECTED_SHA256, '40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db');
});

test('optional selection patch parses the exact reviewed vendor bundle and reverses to its icon-patched bytes', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Requires the temporary reviewed vendor bundle',
}, () => {
  const original = fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE, 'utf8');
  const iconPatched = Buffer.from(iconTransform(original));
  const { output, report } = patchBundle(iconPatched);
  assert.equal(report.replacements, 1);
  assert.ok(output.toString().includes(AFTER));
  assert.equal(output.toString().replace(AFTER, BEFORE), iconPatched.toString());
  const renderer = text => text.slice(text.indexOf('function VSe('), text.indexOf('function OB(', text.indexOf('function VSe(')));
  for (const type of ['heat', 'cool']) {
    const id = `target_temperature.${type}`, lookups = [], writes = [];
    const device = { capabilitiesObj: Object.fromEntries([
      [id, { id, value: type === 'heat' ? 72 : 76 }],
      [`measure_temperature.${type}`, { id: `measure_temperature.${type}`, value: 75 }],
      [`thermostat_mode.${type}`, { id: `thermostat_mode.${type}`, value: type }],
    ]) };
    const context = vm.createContext({
      WN: () => ({ device }),
      P: { useMemo: work => work(), useState: () => [`target_temperature.${type === 'heat' ? 'cool' : 'heat'}`, () => {}] },
      KI: { default: callback => callback },
      pR: ({ capabilityId }) => {
        lookups.push(capabilityId);
        return [device.capabilitiesObj[capabilityId]?.value ?? null,
          value => { writes.push({ capabilityId, value }); return Promise.resolve(); }, device.capabilitiesObj[capabilityId]];
      },
      L: { jsx: (component, props) => ({ component, props }), jsxs: (component, props) => ({ component, props }) },
      uR: 'root', fR: 'header', lR: 'selector', dR: 'body', PSe: 'dial',
    });
    vm.runInContext(renderer(output.toString()), context);
    const result = context.VSe({ deviceId: 'fixture', component: { capabilities: [id] } });
    const dial = result.props.children.find(child => child.component === 'body').props.children;
    assert.equal(dial.props.targetValue, type === 'heat' ? 72 : 76);
    assert.equal(lookups[0], id, 'A removed selected target must resolve the surviving writer');
    dial.props.onTargetValueChange(74);
    assert.deepEqual(writes, [{ capabilityId: id, value: 74 }]);
  }
});
