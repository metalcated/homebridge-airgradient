'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const patches = require('../scripts/patch-homey-13.5.3-thermostat-buttons.cjs');
const { transformSource: iconTransform } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');
const { transformSource: selectionTransform } = require('../scripts/patch-homey-13.5.3-thermostat.cjs');
const { patchBundle: controlsBundle } = require('../scripts/patch-homey-13.5.3-controls.cjs');
const DRIVER = 'homey:app:com.metalcated.lennox:thermostat';
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!tree || typeof tree !== 'object') return '';
  return Array.isArray(tree) ? tree.map(text).join(' ') : text(tree.props?.children);
}

function renderHarness({ driverId = DRIVER, units = 'imperial', onWrite = () => Promise.resolve(), hookCapability } = {}) {
  const device = { id: 'coalescer-device', driverId, available: true,
    settings: { read_only: false, temperature_control_units: units },
    capabilitiesObj: { thermostat_mode: { id: 'thermostat_mode', value: 'auto', getable: true, setable: true } } };
  for (const kind of ['heat', 'cool']) {
    for (const [prefix, value] of [['target_temperature', kind === 'heat' ? 72 : 76], ['measure_temperature', 74], ['thermostat_mode', kind]]) {
      const id = `${prefix}.${kind}`;
      device.capabilitiesObj[id] = { id, value, getable: true, setable: prefix === 'target_temperature', min: 40, max: 90, step: 1, units: '°F', decimals: 0 };
    }
    for (const direction of ['decrease', 'increase']) {
      const id = `${kind}_${direction}`;
      device.capabilitiesObj[id] = { id, value: null, getable: false, setable: true };
    }
  }
  const component = { capabilities: ['target_temperature.heat', 'target_temperature.cool'] };
  const slots = [], requests = [], instanceWrites = [], toasts = [], timers = new Map();
  let now = 0, sequence = 0, cursor = 0, effects = [], dirty = false, mounted = true;
  const setTimer = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + Number(delay) }); return id; };
  const clearTimer = id => timers.delete(id);
  const same = (left, right) => left && right && left.length === right.length && left.every((entry, index) => Object.is(entry, right[index]));
  const write = request => { requests.push(plain(request)); return Promise.resolve().then(() => onWrite(request)); };
  const instance = { id: device.id, manager: { setCapabilityValue: write }, makeCapabilityInstance: id => ({
    setValue(value) { instanceWrites.push({ capabilityId: id, value }); return Promise.resolve(); }, destroy() {},
  }) };
  const react = {
    useState(initial) {
      const id = cursor++;
      if (!Object.hasOwn(slots, id)) slots[id] = typeof initial === 'function' ? initial() : initial;
      return [slots[id], value => { const next = typeof value === 'function' ? value(slots[id]) : value; if (!Object.is(next, slots[id])) { slots[id] = next; dirty = true; } }];
    },
    useRef(initial) { const id = cursor++; if (!Object.hasOwn(slots, id)) slots[id] = { current: initial }; return slots[id]; },
    useMemo(work, dependencies) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) slots[id] = { dependencies, value: work() }; return slots[id].value; },
    useEffect(work, dependencies) {
      const id = cursor++;
      if (!slots[id] || !same(slots[id].dependencies, dependencies)) {
        slots[id]?.cleanup?.(); slots[id] = { dependencies };
        effects.push(() => { slots[id].cleanup = work(); });
      }
    },
  };
  const context = vm.createContext({ P: react, WN: () => ({ device, deviceInstance: instance }),
    WE: callback => callback, q: { handleError: error => toasts.push(error.message) },
    KI: { default: callback => callback },
    L: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    R: type => () => type, uR: 'root', fR: 'header', lR: 'selector', dR: 'body', PSe: 'dial',
    setTimeout: setTimer, clearTimeout: clearTimer,
  });
  const source = hookCapability === undefined ? patches.COALESCED_AFTER
    : `function VSe(e){return pR({deviceId:e.deviceId,capabilityId:${JSON.stringify(hookCapability)},requestTimeout:45000})}`;
  vm.runInContext(patches.COALESCED_HOOK_AFTER + '\n' + source, context);
  function render() {
    assert.equal(mounted, true);
    for (let pass = 0; pass < 8; pass++) {
      cursor = 0; effects = []; dirty = false;
      const tree = context.VSe({ deviceId: device.id, component });
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw Error('Renderer did not settle');
  }
  return { device, component, requests, instanceWrites, toasts, timers, render,
    click(direction) {
      const pair = nodes(render(), 'button');
      const button = pair[direction < 0 ? 0 : 1];
      assert.ok(button && !button.props.disabled, 'Rapid adjustments must remain clickable while another batch is in flight');
      button.props.onClick({ stopPropagation() {} });
      return render();
    },
    async advance(milliseconds) {
      const until = now + milliseconds;
      while (true) {
        const [id, task] = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0] ?? [];
        if (!task || task.at > until) break;
        now = task.at; timers.delete(id); task.callback(); await settle();
        if (mounted) render();
      }
      now = until; await settle();
      return mounted ? render() : undefined;
    },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('rapid dial presses coalesce after a quiet period and show pending intent without changing the confirmed target', async () => {
  const pending = deferred();
  const rendered = renderHarness({ onWrite: () => pending.promise });
  rendered.click(1); rendered.click(1);
  let tree = rendered.click(1);
  assert.equal(nodes(tree, 'dial')[0].props.targetValue, 72);
  assert.match(text(tree), /Queued/i);
  assert.equal(rendered.requests.length, 0);
  await rendered.advance(599);
  assert.equal(rendered.requests.length, 0);
  tree = await rendered.advance(1);
  assert.deepEqual(rendered.requests, [{ deviceId: rendered.device.id, capabilityId: 'heat_increase', value: true, opts: { steps: 3 }, $timeout: 45000 }]);
  assert.match(text(tree), /Applying/i);
  assert.equal(nodes(tree, 'dial')[0].props.targetValue, 72);
  assert.ok(nodes(tree, 'button').every(button => !button.props.disabled));
  pending.resolve(); await settle();
  assert.doesNotMatch(text(rendered.render()), /Applying|Queued/i);
});

test('reversed presses cancel their net delta and a burst is capped at twenty steps', async () => {
  const rendered = renderHarness();
  rendered.click(1); rendered.click(-1);
  await rendered.advance(600);
  assert.equal(rendered.requests.length, 0);
  rendered.device.capabilitiesObj['target_temperature.heat'] = { ...rendered.device.capabilitiesObj['target_temperature.heat'], value: 50 };
  for (let count = 0; count < 20; count++) rendered.click(1);
  const capped = nodes(rendered.render(), 'button')[1];
  assert.equal(capped.props.disabled, true);
  for (let count = 0; count < 5; count++) capped.props.onClick({ stopPropagation() {} });
  await rendered.advance(600);
  assert.equal(rendered.requests.length, 1);
  assert.equal(rendered.requests[0].opts.steps, 20);
  assert.equal(rendered.requests[0].capabilityId, 'heat_increase');
});

test('presses during an in-flight batch remain clickable and the ready next batch flushes only after that result', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const rendered = renderHarness({ onWrite: () => ++count === 1 ? first.promise : second.promise });
  rendered.click(1); rendered.click(1);
  await rendered.advance(600);
  rendered.click(1); rendered.click(1); rendered.click(1);
  await rendered.advance(600);
  assert.equal(rendered.requests.length, 1);
  first.resolve(); await settle();
  assert.deepEqual(rendered.requests.map(request => request.opts.steps), [2, 3]);
  second.resolve(); await settle();
  assert.doesNotMatch(text(rendered.render()), /Applying|Queued/i);
});

test('a failed batch is not automatically resent while a separately queued new intent can proceed', async () => {
  const first = deferred();
  let count = 0;
  const rendered = renderHarness({ onWrite: () => ++count === 1 ? first.promise : Promise.resolve() });
  rendered.click(1); rendered.click(1);
  await rendered.advance(600);
  rendered.click(-1);
  await rendered.advance(600);
  first.reject(Error('Emulated thermostat rejected the first batch'));
  await settle();
  assert.deepEqual(rendered.requests.map(request => [request.capabilityId, request.opts.steps]), [['heat_increase', 2], ['heat_decrease', 1]]);
  assert.deepEqual(rendered.toasts, ['Emulated thermostat rejected the first batch']);
  await rendered.advance(1200);
  assert.equal(rendered.requests.length, 2);
  assert.equal(nodes(rendered.render(), 'dial')[0].props.targetValue, 72);
});

test('selection, mode, permission, availability, units, native dragging and unmount cancel unsent adjustments', async () => {
  for (const change of [
    rendered => nodes(rendered.render(), 'selector')[0].props.onSelectionChange('target_temperature.cool'),
    rendered => { rendered.device.capabilitiesObj.thermostat_mode = { ...rendered.device.capabilitiesObj.thermostat_mode, value: 'heat' }; },
    rendered => { rendered.device.settings.read_only = true; },
    rendered => { rendered.device.available = false; },
    rendered => { rendered.device.settings.temperature_control_units = 'metric'; },
    rendered => { rendered.device.id = 'replacement-device'; },
  ]) {
    const rendered = renderHarness();
    rendered.click(1); change(rendered); rendered.render();
    await rendered.advance(600);
    assert.equal(rendered.requests.length, 0);
  }
  const drag = renderHarness();
  drag.click(1);
  nodes(drag.render(), 'dial')[0].props.onTargetValueChange(74);
  await settle(); await drag.advance(600);
  assert.equal(drag.requests.length, 0);
  await drag.advance(400);
  assert.deepEqual(drag.requests, [{ deviceId: drag.device.id, capabilityId: 'target_temperature.heat', value: 74, $timeout: 45000 }]);
  const unmounted = renderHarness();
  unmounted.click(1); unmounted.unmount();
  await unmounted.advance(600);
  assert.equal(unmounted.requests.length, 0);
});

test('a pending native drag forms a barrier so later button presses cannot overtake its confirmed result', async () => {
  const absolute = deferred(), relative = deferred();
  const rendered = renderHarness({ onWrite: request => request.capabilityId.startsWith('target_temperature') ? absolute.promise : relative.promise });
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(74);
  await rendered.advance(100);
  rendered.click(1);
  await rendered.advance(600);
  assert.equal(rendered.requests.length, 0, 'The relative quiet period expires at 700ms but the preceding drag still owns the barrier');
  await rendered.advance(300);
  assert.deepEqual(rendered.requests, [{ deviceId: rendered.device.id, capabilityId: 'target_temperature.heat', value: 74, $timeout: 45000 }]);
  assert.ok(nodes(rendered.render(), 'button').every(button => !button.props.disabled));
  absolute.resolve(); await settle();
  assert.deepEqual(rendered.requests.at(-1), { deviceId: rendered.device.id, capabilityId: 'heat_increase', value: true, opts: { steps: 1 }, $timeout: 45000 });
  relative.resolve(); await settle();
  assert.equal(rendered.requests.length, 2);
});

test('a newer drag supersedes an unsent older drag and can wait behind an in-flight request without losing later button intent', async () => {
  const active = deferred();
  let count = 0;
  const rendered = renderHarness({ onWrite: () => ++count === 1 ? active.promise : Promise.resolve() });
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(73);
  await rendered.advance(200);
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(74);
  await rendered.advance(800);
  assert.equal(rendered.requests.length, 0, 'The superseded first drag must not publish at its former deadline');
  await rendered.advance(200);
  assert.equal(rendered.requests[0].value, 74);
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(75);
  rendered.click(1); rendered.click(1);
  await rendered.advance(1000);
  assert.equal(rendered.requests.length, 1);
  active.resolve(); await settle();
  assert.deepEqual(rendered.requests.map(request => [request.capabilityId, request.value, request.opts?.steps]), [
    ['target_temperature.heat', 74, undefined], ['target_temperature.heat', 75, undefined], ['heat_increase', true, 2],
  ]);
});

test('unmount cancels the next batch even if an already transmitted request settles afterward', async () => {
  const pending = deferred();
  const rendered = renderHarness({ onWrite: () => pending.promise });
  rendered.click(1); await rendered.advance(600);
  rendered.click(1); await rendered.advance(600);
  rendered.unmount();
  pending.resolve(); await settle(); await rendered.advance(1000);
  assert.equal(rendered.requests.length, 1);
  assert.equal(rendered.timers.size, 0);
});

test('Celsius pending intent uses half-degree steps while keeping the confirmed dial value unchanged', async () => {
  const rendered = renderHarness({ units: 'metric' });
  for (const id of ['target_temperature.heat', 'target_temperature.cool']) {
    const capability = rendered.device.capabilitiesObj[id];
    Object.assign(capability, { value: id.endsWith('.heat') ? 22 : 25, min: 4.5, max: 32, step: 0.5, units: '°C' });
  }
  rendered.click(1); rendered.click(1);
  const tree = rendered.click(1);
  assert.match(text(tree), /Queued \+1\.5°C/);
  assert.equal(nodes(tree, 'dial')[0].props.targetValue, 22);
  await rendered.advance(600);
  assert.equal(rendered.requests[0].opts.steps, 3);
});

test('the actual coalesced hook validates relative step options, drops unrelated options and leaves native requests unchanged', async () => {
  const relative = renderHarness({ hookCapability: 'heat_increase' });
  for (const steps of [0, 21, 1.5, '2', NaN, null, true]) {
    await assert.rejects(relative.render()[1](true, { steps }), /whole number from 1 to 20/);
    await settle();
  }
  assert.equal(relative.requests.length, 0);
  await relative.render()[1](true, { steps: 2, duration: 500, unrelated: 'discard' });
  assert.deepEqual(relative.requests, [{ deviceId: relative.device.id, capabilityId: 'heat_increase', value: true, opts: { steps: 2 }, $timeout: 45000 }]);
  await relative.render()[1](true, { duration: 500 });
  assert.deepEqual(relative.requests.at(-1), { deviceId: relative.device.id, capabilityId: 'heat_increase', value: true, $timeout: 45000 });
  const native = renderHarness({ hookCapability: 'target_temperature.heat' });
  await native.render()[1](74, { steps: 0, duration: 500 });
  assert.deepEqual(native.requests, [{ deviceId: native.device.id, capabilityId: 'target_temperature.heat', value: 74, $timeout: 45000 }]);
});

test('coalescing remains scoped to Lennox and preserves the original layer for exact rollback', () => {
  const other = renderHarness({ driverId: 'homey:app:other.vendor:thermostat' });
  const tree = other.render();
  assert.equal(nodes(tree, 'button').length, 0);
  assert.equal(typeof nodes(tree, 'dial')[0].props.onTargetValueChange, 'function');
  assert.equal(patches.transformCoalescedSource(patches.HOOK_AFTER + '\n' + patches.AFTER), patches.COALESCED_HOOK_AFTER + '\n' + patches.COALESCED_AFTER);
  assert.throws(() => patches.transformCoalescedSource(''), /found 0/);
  assert.throws(() => patches.transformCoalescedSource(patches.HOOK_AFTER + patches.HOOK_AFTER + '\n' + patches.AFTER), /found 2/);
  assert.throws(() => patches.transformCoalescedSource(patches.COALESCED_HOOK_AFTER + '\n' + patches.COALESCED_AFTER), /found 0/);
});

test('the reviewed current controls bundle receives only the coalescing layer and reverses exactly', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Requires the temporary reviewed vendor bundle',
}, () => {
  const selected = Buffer.from(selectionTransform(iconTransform(fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE, 'utf8'))));
  const current = controlsBundle(selected).output;
  const { output, report } = patches.patchCoalescedBundle(current);
  assert.equal(report.replacements, 2);
  assert.equal(output.toString().replace(patches.COALESCED_AFTER, patches.AFTER).replace(patches.COALESCED_HOOK_AFTER, patches.HOOK_AFTER), current.toString());
});
