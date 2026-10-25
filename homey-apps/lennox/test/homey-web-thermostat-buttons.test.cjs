'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { BEFORE, AFTER, HOOK_BEFORE, HOOK_AFTER, EXPECTED_SHA256, transformSource, patchBundle, writePatchedBundle } = require('../scripts/patch-homey-13.5.3-thermostat-buttons.cjs');
const { transformSource: iconTransform } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');
const { transformSource: selectionTransform } = require('../scripts/patch-homey-13.5.3-thermostat.cjs');

const DRIVER = 'homey:app:com.metalcated.lennox:thermostat';
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function click(button) {
  let stopped = 0;
  button.props.onClick({ stopPropagation() { stopped++; } });
  assert.equal(stopped, 1, 'A button press must not bubble into the draggable dial');
}

function fixture({ single = false, driverId = DRIVER, readOnly = false, mode = 'auto', available = true } = {}) {
  const device = { id: 'fixture-device', driverId, available, settings: { read_only: readOnly },
    capabilitiesObj: { thermostat_mode: { id: 'thermostat_mode', value: mode, getable: true, setable: true } } };
  for (const type of single ? ['target'] : ['heat', 'cool']) {
    const suffix = type === 'target' ? '' : `.${type}`;
    for (const [prefix, value] of [['target_temperature', type === 'cool' ? 76 : 72], ['measure_temperature', 74], ['thermostat_mode', type === 'cool' ? 'cool' : 'heat']]) {
      const id = prefix + suffix;
      device.capabilitiesObj[id] = { id, value: prefix === 'thermostat_mode' && type === 'target' ? mode : value, getable: true, setable: prefix === 'target_temperature',
        min: 40, max: 90, step: 1, decimals: 0, units: '°F' };
    }
    for (const direction of ['decrease', 'increase']) {
      const id = `${type}_${direction}`;
      device.capabilitiesObj[id] = { id, getable: false, setable: true, value: null };
    }
  }
  return { device, component: { capabilities: single ? ['target_temperature'] : ['target_temperature.heat', 'target_temperature.cool'] } };
}

function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(node => nodes(node, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}

// Execute the reviewed renderer with persistent React hook slots. This checks
// actual handlers and selection/pending rerenders, not a parallel UI model.
function renderer({ source = AFTER, selected, actualHook, onWrite = () => Promise.resolve(), ...options } = {}) {
  const data = fixture(options), slots = [], writes = [], toasts = [], lookups = [], managerRequests = [], instanceWrites = [];
  let cursor = 0, effects = [], changed = false;
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const write = (capabilityId, value) => {
    writes.push({ capabilityId, value });
    return Promise.resolve().then(() => onWrite(capabilityId, value));
  };
  const deviceInstance = { id: data.device.id,
    manager: { setCapabilityValue(request) {
      managerRequests.push(plain(request));
      return write(request.capabilityId, request.value);
    } },
    makeCapabilityInstance: capabilityId => ({ setValue: value => {
      instanceWrites.push({ capabilityId, value });
      return write(capabilityId, value);
    }, destroy() {} }),
  };
  const context = vm.createContext({
    WN: () => ({ device: data.device, deviceInstance }),
    P: {
      useState: initial => {
        const index = cursor++;
        if (!Object.hasOwn(slots, index)) {
          const value = typeof initial === 'function' ? initial() : initial;
          slots[index] = typeof value === 'string' && value.startsWith('target_temperature') && selected !== undefined ? selected : value;
        }
        return [slots[index], value => {
          const next = typeof value === 'function' ? value(slots[index]) : value;
          if (!Object.is(next, slots[index])) { slots[index] = next; changed = true; }
        }];
      },
      useRef: initial => {
        const index = cursor++;
        if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
        return slots[index];
      },
      useMemo: (work, deps) => {
        const index = cursor++;
        if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: work(), deps };
        return slots[index].value;
      },
      useEffect: (work, deps) => {
        const index = cursor++;
        if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
          slots[index]?.cleanup?.();
          slots[index] = { deps };
          effects.push(() => { slots[index].cleanup = work(); });
        }
      },
    },
    WE: callback => callback,
    q: { handleError: error => toasts.push(error.message) },
    KI: { default: callback => callback },
    pR: ({ capabilityId }) => {
      lookups.push(capabilityId);
      const capability = data.device.capabilitiesObj[capabilityId];
      return [capability?.value ?? null, value => {
        if (!capability || capability.setable === false) return Promise.reject(Error('Capability is unavailable'));
        return write(capabilityId, value);
      }, capability ?? null];
    },
    L: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    R: type => () => type,
    uR: 'root', fR: 'header', lR: 'selector', dR: 'body', PSe: 'dial',
  });
  vm.runInContext((actualHook ?? '') + '\n' + source, context);
  return { ...data, writes, toasts, lookups, managerRequests, instanceWrites,
    render() {
      let tree;
      for (let index = 0; index < 5; index++) {
        cursor = 0; effects = []; changed = false;
        tree = context.VSe({ deviceId: data.device.id, component: data.component });
        for (const effect of effects) effect();
        if (!changed) return tree;
      }
      throw Error('Renderer did not settle');
    },
  };
}

test('dial button transformer requires exactly one reviewed renderer and refuses unreviewed or overwrite inputs', () => {
  assert.equal(EXPECTED_SHA256, '5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215');
  assert.equal(transformSource(HOOK_BEFORE + '\n' + BEFORE), HOOK_AFTER + '\n' + AFTER);
  assert.throws(() => transformSource(''), /found 0/);
  assert.throws(() => transformSource(HOOK_BEFORE + '\n' + BEFORE + BEFORE), /found 2/);
  assert.throws(() => transformSource(HOOK_BEFORE + HOOK_BEFORE + '\n' + BEFORE), /found 2/);
  assert.throws(() => transformSource(HOOK_AFTER + '\n' + AFTER), /found 0/);
  assert.throws(() => patchBundle(Buffer.from(BEFORE)), /Unsupported/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-dial-buttons-'));
  const input = path.join(directory, 'original.js'), output = path.join(directory, 'patched.js');
  fs.writeFileSync(input, BEFORE);
  assert.throws(() => writePatchedBundle(input, input), /input|differ|untouched/i);
  assert.throws(() => writePatchedBundle(input, output), /Unsupported/);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, 'keep existing output');
  assert.throws(() => writePatchedBundle(input, output), /Output already exists/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep existing output');
  assert.equal(fs.readFileSync(input, 'utf8'), BEFORE);
});

test('the actual patched dial exposes small native buttons and routes each selected target to its relative capabilities', async () => {
  const rendered = renderer();
  let tree = rendered.render();
  let pair = nodes(tree, 'button');
  assert.equal(pair.length, 2);
  for (const button of pair) {
    assert.equal(button.props.type, 'button', 'Native button activation handles mouse, Enter and Space without a duplicate key handler');
    assert.equal(typeof button.props.onClick, 'function');
    assert.equal(button.props.onKeyDown, undefined);
    assert.equal(button.props.onKeyUp, undefined);
    assert.equal(typeof button.props['aria-label'], 'string');
    assert.ok(button.props['aria-label'].length > 3);
    assert.equal(button.props.disabled, false);
  }
  click(pair[0]);
  await settle();
  assert.deepEqual(rendered.writes, [{ capabilityId: 'heat_decrease', value: true }]);
  nodes(tree, 'selector')[0].props.onSelectionChange('target_temperature.cool');
  tree = rendered.render();
  pair = nodes(tree, 'button');
  click(pair[1]);
  await settle();
  assert.deepEqual(rendered.writes.at(-1), { capabilityId: 'cool_increase', value: true });
  const dial = nodes(tree, 'dial')[0];
  assert.equal(dial.props.targetValue, 76);
  assert.equal(dial.props.measureValue, 74);
  assert.equal(dial.props.units, '°F');
  assert.equal(dial.props.step, 1);
  dial.props.onTargetValueChange(78);
  await settle();
  assert.deepEqual(rendered.writes.at(-1), { capabilityId: 'target_temperature.cool', value: 78 }, 'Dragging retains the native absolute writer');
  const single = renderer({ single: true });
  click(nodes(single.render(), 'button')[1]);
  await settle();
  assert.deepEqual(single.writes, [{ capabilityId: 'target_increase', value: true }]);
});

test('the dial buttons preserve valid selection and resolve a removed selection before choosing a writer', async () => {
  const rendered = renderer({ selected: 'target_temperature.cool' });
  rendered.component.capabilities = ['target_temperature.heat'];
  delete rendered.device.capabilitiesObj['target_temperature.cool'];
  click(nodes(rendered.render(), 'button')[1]);
  await settle();
  assert.deepEqual(rendered.writes, [{ capabilityId: 'heat_increase', value: true }]);
});

test('button bounds and unavailable or read-only state prevent relative writes without removing native dragging', async () => {
  for (const [change, disabled] of [
    [device => { device.settings.read_only = true; }, [true, true]],
    [device => { delete device.settings.read_only; }, [true, true]],
    [device => { device.available = false; }, [true, true]],
    [device => { device.capabilitiesObj['target_temperature.heat'].setable = false; }, [true, true]],
    [device => { device.capabilitiesObj['target_temperature.heat'].value = null; }, [true, true]],
    [device => { device.capabilitiesObj['target_temperature.heat'].value = 40; }, [true, false]],
    [device => { device.capabilitiesObj['target_temperature.heat'].value = 90; }, [false, true]],
    [device => { device.capabilitiesObj.heat_decrease.setable = false; }, [true, false]],
    [device => { device.capabilitiesObj.heat_increase.setable = false; }, [false, true]],
  ]) {
    const rendered = renderer();
    change(rendered.device);
    const tree = rendered.render(), pair = nodes(tree, 'button');
    assert.equal(nodes(tree, 'dial').length, 1);
    assert.deepEqual(pair.map(button => button.props.disabled), disabled);
    for (const [index, button] of pair.entries()) {
      if (disabled[index]) click(button); // Even a stale/programmatic handler must retain the safety guard.
    }
    await settle();
    assert.deepEqual(rendered.writes, []);
  }
});

test('in-flight adjustments suppress rapid duplicate presses and unlock after failure or completion', async () => {
  let resolve, reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const rendered = renderer({ onWrite: () => pending });
  let pair = nodes(rendered.render(), 'button');
  click(pair[1]);
  click(pair[1]);
  click(pair[0]);
  await settle();
  assert.deepEqual(rendered.writes, [{ capabilityId: 'heat_increase', value: true }], 'A ref must suppress extra presses before React rerenders');
  pair = nodes(rendered.render(), 'button');
  assert.ok(pair.every(button => button.props.disabled));
  reject(Error('Emulated readback timeout'));
  await settle();
  pair = nodes(rendered.render(), 'button');
  assert.ok(pair.every(button => !button.props.disabled), 'An error must release the pending guard for retry');
  // A new fulfilled backend result permits the next deliberate press.
  const completed = renderer({ onWrite: () => Promise.resolve() });
  pair = nodes(completed.render(), 'button');
  click(pair[0]);
  await settle();
  click(nodes(completed.render(), 'button')[1]);
  await settle();
  assert.deepEqual(completed.writes, [{ capabilityId: 'heat_decrease', value: true }, { capabilityId: 'heat_increase', value: true }]);
  resolve();
});

test('other thermostats and unsupported selections keep the original dial without Lennox buttons', () => {
  for (const options of [
    { driverId: 'homey:app:other.vendor:thermostat' },
    { driverId: DRIVER + '-other' },
    { driverId: 'homey:manager:vdevice' },
    { mode: 'off' }, { mode: 'future-mode' },
  ]) {
    const rendered = renderer(options);
    const tree = rendered.render();
    assert.equal(nodes(tree, 'button').length, 0);
    const dial = nodes(tree, 'dial')[0];
    assert.equal(dial.props.targetValue, 72);
    assert.equal(typeof dial.props.onTargetValueChange, 'function');
    assert.deepEqual(rendered.writes, []);
  }
  const missing = renderer();
  delete missing.device.capabilitiesObj.heat_increase;
  const tree = missing.render();
  assert.equal(nodes(tree, 'button').length, 0);
  assert.equal(nodes(tree, 'dial').length, 1);
});

function hookProbe({ capabilityId, timeout = 45000, omitTimeout = false, ...options }) {
  const source = `function VSe(e){return pR({deviceId:e.deviceId,capabilityId:e.component.capabilities[0]${omitTimeout ? '' : ',requestTimeout:' + JSON.stringify(timeout)}})}`;
  const result = renderer({ ...options, source, actualHook: HOOK_AFTER });
  result.component.capabilities = [capabilityId];
  return result;
}

test('the actual patched hook gives only the nine scoped Lennox temperature writers a 45-second manager request', async () => {
  for (const capabilityId of [
    'target_temperature', 'target_temperature.heat', 'target_temperature.cool',
    'heat_decrease', 'heat_increase', 'cool_decrease', 'cool_increase', 'target_decrease', 'target_increase',
  ]) {
    const single = ['target_temperature', 'target_decrease', 'target_increase'].includes(capabilityId);
    const rendered = hookProbe({ capabilityId, single });
    const value = capabilityId.startsWith('target_temperature') ? 74 : true;
    await rendered.render()[1](value);
    await settle();
    assert.deepEqual(rendered.managerRequests, [{ deviceId: rendered.device.id, capabilityId, value, $timeout: 45000 }], capabilityId);
    assert.deepEqual(rendered.instanceWrites, [], 'The ordinary capability-instance API drops the timeout option');
  }
});

test('other devices, unrelated capabilities and ordinary hook requests retain their original capability-instance path', async () => {
  for (const options of [
    { driverId: 'homey:app:other.vendor:thermostat', capabilityId: 'target_temperature.heat' },
    { driverId: DRIVER + '-other', capabilityId: 'target_temperature.heat' },
    { capabilityId: 'thermostat_mode' }, { capabilityId: 'fan_mode' },
    { capabilityId: 'heat_target' }, { capabilityId: 'target_temperature.extra' },
    { capabilityId: 'target_temperature.heat', omitTimeout: true },
    { capabilityId: 'target_temperature.heat', timeout: null },
    { capabilityId: 'target_temperature.heat', timeout: 10000 },
    { capabilityId: 'target_temperature.heat', timeout: 45001 },
  ]) {
    const rendered = hookProbe(options);
    rendered.device.capabilitiesObj[options.capabilityId] ??= { id: options.capabilityId, value: 72, getable: true, setable: true };
    await rendered.render()[1](74);
    await settle();
    assert.deepEqual(rendered.managerRequests, []);
    assert.deepEqual(rendered.instanceWrites, [{ capabilityId: options.capabilityId, value: 74 }]);
  }
});

test('the scoped hook preserves vendor optimistic rollback, one error toast, explicit retry and local-only writes', async () => {
  let attempts = 0;
  const rendered = hookProbe({ capabilityId: 'target_temperature.heat', onWrite: () => ++attempts === 1
    ? Promise.reject(Error('Emulated thermostat denied this write')) : Promise.resolve() });
  let hook = rendered.render();
  assert.equal(hook[0], 72);
  const failed = hook[1](75);
  assert.equal(rendered.render()[0], 75, 'Preserve the existing native hook behavior while the request is pending');
  await assert.rejects(failed, /denied this write/);
  await settle();
  hook = rendered.render();
  assert.equal(hook[0], 72, 'The vendor rejection handler must restore the previous observed value');
  assert.deepEqual(rendered.toasts, ['Emulated thermostat denied this write']);
  await hook[1](74);
  await settle();
  assert.equal(rendered.render()[0], 74);
  assert.equal(rendered.managerRequests.length, 2);
  assert.equal(rendered.toasts.length, 1);
  const local = hookProbe({ capabilityId: 'target_temperature.heat' });
  await local.render()[1](73, { local: true });
  assert.equal(local.render()[0], 73);
  assert.deepEqual(local.managerRequests, []);
  assert.deepEqual(local.instanceWrites, []);
});

const reviewedBundle = process.env.HOMEY_REVIEWED_WEB_BUNDLE;
const actualBundleOptions = { skip: reviewedBundle ? false : 'Requires the temporary reviewed Homey bundle' };
function selectionPatchedInput() {
  return Buffer.from(selectionTransform(iconTransform(fs.readFileSync(reviewedBundle, 'utf8'))));
}

test('the exact reviewed bundle composes all patches, parses and reverses byte-for-byte without changing the draggable dial', actualBundleOptions, () => {
  const input = selectionPatchedInput();
  const { output, report } = patchBundle(input);
  assert.equal(report.replacements, 2);
  assert.equal(report.driverId, DRIVER);
  assert.equal(report.originalSha256, EXPECTED_SHA256);
  assert.notEqual(report.patchedSha256, EXPECTED_SHA256);
  assert.equal(output.toString('utf8').replace(AFTER, BEFORE).replace(HOOK_AFTER, HOOK_BEFORE), input.toString('utf8'));
  const dialSource = source => {
    const start = source.indexOf('function PSe('), end = source.indexOf('function FSe(', start);
    assert.ok(start > 0 && end > start);
    return source.slice(start, end);
  };
  assert.equal(dialSource(output.toString()), dialSource(input.toString()), 'Drag handlers, SVG, rounding and native color behavior remain byte-identical');
  const original = renderer({ source: BEFORE, driverId: 'homey:app:other.vendor:thermostat' });
  const patched = renderer({ driverId: 'homey:app:other.vendor:thermostat' });
  const originalProps = nodes(original.render(), 'dial')[0].props, patchedProps = nodes(patched.render(), 'dial')[0].props;
  assert.deepEqual(plain({ ...patchedProps, onTargetValueChange: undefined }), plain({ ...originalProps, onTargetValueChange: undefined }));
});

test('actual vendor capability hooks show backend errors once and unlock the same dial buttons for retry without optimistic target changes', actualBundleOptions, async () => {
  const source = selectionPatchedInput().toString('utf8');
  const start = source.indexOf('function pR('), end = source.indexOf('var mR=', start);
  assert.ok(start > 0 && end > start);
  assert.equal(source.slice(start, end), HOOK_BEFORE, 'The hook patch must match the exact deployed vendor implementation');
  const actualHook = HOOK_AFTER;
  let attempts = 0;
  const rendered = renderer({ actualHook, onWrite: () => ++attempts === 1
    ? Promise.reject(Error('Emulated thermostat readback timeout')) : Promise.resolve() });
  let tree = rendered.render();
  click(nodes(tree, 'button')[1]);
  await settle();
  assert.deepEqual(rendered.toasts, ['Emulated thermostat readback timeout']);
  assert.deepEqual(rendered.writes, [{ capabilityId: 'heat_increase', value: true }]);
  assert.deepEqual(rendered.managerRequests, [{ deviceId: rendered.device.id, capabilityId: 'heat_increase', value: true, $timeout: 45000 }]);
  assert.deepEqual(rendered.instanceWrites, [], 'The extended request must use the manager option that the SDK actually forwards');
  tree = rendered.render();
  assert.ok(nodes(tree, 'button').every(button => !button.props.disabled));
  assert.equal(nodes(tree, 'dial')[0].props.targetValue, 72, 'A failed relative command must not optimistically change the dial target');
  click(nodes(tree, 'button')[1]);
  await settle();
  assert.equal(rendered.writes.length, 2);
  assert.equal(rendered.toasts.length, 1, 'The button wrapper must reuse the vendor error path rather than add a duplicate toast');
  tree = rendered.render();
  nodes(tree, 'selector')[0].props.onSelectionChange('target_temperature.cool');
  tree = rendered.render();
  click(nodes(tree, 'button')[0]);
  await settle();
  assert.deepEqual(rendered.writes.at(-1), { capabilityId: 'cool_decrease', value: true });
  nodes(tree, 'dial')[0].props.onTargetValueChange(78);
  await settle();
  assert.deepEqual(rendered.managerRequests.at(-1), { deviceId: rendered.device.id, capabilityId: 'target_temperature.cool', value: 78, $timeout: 45000 }, 'The actual native drag hook must opt into the same scoped request timeout');
  assert.deepEqual(rendered.instanceWrites, []);
  const other = renderer({ actualHook, driverId: 'homey:app:other.vendor:thermostat' });
  nodes(other.render(), 'dial')[0].props.onTargetValueChange(74);
  await settle();
  assert.deepEqual(other.managerRequests, []);
  assert.deepEqual(other.instanceWrites, [{ capabilityId: 'target_temperature.heat', value: 74 }]);
});
