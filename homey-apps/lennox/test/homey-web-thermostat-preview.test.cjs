'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const patches = require('../scripts/patch-homey-13.5.3-thermostat-buttons.cjs');
const { transformSource: icons } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');
const { transformSource: selection } = require('../scripts/patch-homey-13.5.3-thermostat.cjs');
const { patchBundle: controls } = require('../scripts/patch-homey-13.5.3-controls.cjs');
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plain = value => JSON.parse(JSON.stringify(value));
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

function harness({ onWrite = () => Promise.resolve(), driverId = 'homey:app:com.metalcated.lennox:thermostat', hookCapability, requestTimeout = 45000 } = {}) {
  const device = { id: 'preview-device', driverId, available: true,
    settings: { read_only: false, temperature_control_units: 'imperial' }, capabilitiesObj: {} };
  const capabilities = device.capabilitiesObj;
  capabilities.thermostat_mode = { id: 'thermostat_mode', value: 'auto', getable: true, setable: true };
  for (const kind of ['heat', 'cool']) {
    for (const [prefix, value] of [['target_temperature', kind === 'heat' ? 74 : 80], ['measure_temperature', 73], ['thermostat_mode', kind]]) {
      const id = `${prefix}.${kind}`;
      capabilities[id] = { id, value, getable: true, setable: prefix === 'target_temperature', min: 40, max: 90, step: 1, units: '°F', decimals: 0 };
    }
    for (const direction of ['decrease', 'increase']) {
      const id = `${kind}_${direction}`;
      capabilities[id] = { id, value: null, getable: false, setable: true };
    }
  }
  const component = { capabilities: ['target_temperature.heat', 'target_temperature.cool'] };
  if (hookCapability && !capabilities[hookCapability]) capabilities[hookCapability] = { id: hookCapability, value: 74, getable: true, setable: true };
  const slots = [], requests = [], instanceWrites = [], toasts = [], listeners = new Map(), timers = new Map();
  let cursor = 0, effects = [], dirty = false, mounted = true, now = 0, sequence = 0;
  const setTimer = (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: now + Number(delay) }); return id; };
  const clearTimer = id => timers.delete(id);
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const instance = { id: device.id, manager: { setCapabilityValue(request) { requests.push(plain(request)); return Promise.resolve().then(() => onWrite(request)); } },
    makeCapabilityInstance(id, callback) {
      const subscribers = listeners.get(id) ?? new Set();
      listeners.set(id, subscribers); subscribers.add(callback);
      return { setValue: value => { const request = { capabilityId: id, value }; instanceWrites.push(request); return Promise.resolve().then(() => onWrite(request)); }, destroy: () => subscribers.delete(callback) };
    } };
  const react = {
    useState(initial) { const id = cursor++; if (!Object.hasOwn(slots, id)) slots[id] = typeof initial === 'function' ? initial() : initial;
      return [slots[id], value => { const next = typeof value === 'function' ? value(slots[id]) : value; if (!Object.is(next, slots[id])) { slots[id] = next; dirty = true; } }]; },
    useRef(initial) { const id = cursor++; if (!Object.hasOwn(slots, id)) slots[id] = { current: initial }; return slots[id]; },
    useMemo(work, dependencies) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) slots[id] = { dependencies, value: work() }; return slots[id].value; },
    useEffect(work, dependencies) { const id = cursor++; if (!slots[id] || !same(slots[id].dependencies, dependencies)) {
      slots[id]?.cleanup?.(); slots[id] = { dependencies }; effects.push(() => { slots[id].cleanup = work(); }); } },
  };
  const context = vm.createContext({ P: react, WN: () => ({ device, deviceInstance: instance }),
    WE: callback => callback, q: { handleError: error => toasts.push(error.message) }, KI: { default: callback => callback },
    L: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    R: type => () => type, uR: 'root', fR: 'header', lR: 'selector', dR: 'body', PSe: 'dial',
    setTimeout: setTimer, clearTimeout: clearTimer });
  const source = hookCapability === undefined ? patches.PREVIEW_AFTER
    : `function VSe(e){return pR({deviceId:e.deviceId,capabilityId:${JSON.stringify(hookCapability)},requestTimeout:${JSON.stringify(requestTimeout)}})}`;
  vm.runInContext(patches.PREVIEW_HOOK_AFTER + '\n' + source, context);
  function render() {
    assert.equal(mounted, true);
    for (let pass = 0; pass < 10; pass++) {
      cursor = 0; effects = []; dirty = false;
      const tree = context.VSe({ deviceId: device.id, component });
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw Error('Preview renderer did not settle');
  }
  return { device, component, requests, instanceWrites, toasts, timers, render,
    value: () => nodes(render(), 'dial')[0].props.targetValue,
    click(direction) { const button = nodes(render(), 'button')[direction < 0 ? 0 : 1]; assert.ok(button && !button.props.disabled);
      button.props.onClick({ stopPropagation() {} }); return render(); },
    report(id, value) { capabilities[id] = { ...capabilities[id], value }; for (const callback of listeners.get(id) ?? []) callback(value); return render(); },
    socketReport(id, value) { for (const callback of listeners.get(id) ?? []) callback(value); return render(); },
    async advance(milliseconds) {
      const until = now + milliseconds;
      while (true) {
        const [id, task] = [...timers.entries()].sort((left, right) => left[1].at - right[1].at)[0] ?? [];
        if (!task || task.at > until) break;
        now = task.at; timers.delete(id); task.callback(); await settle(); if (mounted) render();
      }
      now = until; await settle(); return mounted ? render() : undefined;
    },
    unmount() { mounted = false; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('button presses immediately preview the dial without visible status text or mutations to reported values', async () => {
  const pending = deferred();
  const rendered = harness({ onWrite: () => pending.promise });
  assert.equal(rendered.value(), 74);
  rendered.click(1); rendered.click(1);
  const tree = rendered.click(1);
  assert.equal(rendered.value(), 77);
  assert.equal(rendered.device.capabilitiesObj['target_temperature.heat'].value, 74);
  assert.doesNotMatch(text(tree), /Applying|Queued/i);
  assert.equal(rendered.requests.length, 0);
  await rendered.advance(600);
  assert.equal(rendered.value(), 77);
  assert.deepEqual(rendered.requests, [{ deviceId: rendered.device.id, capabilityId: 'heat_increase', value: true, opts: { steps: 3 }, $timeout: 45000 }]);
  assert.doesNotMatch(text(rendered.render()), /Applying|Queued/i);
  rendered.report('target_temperature.heat', 77);
  pending.resolve(); await settle();
  assert.equal(rendered.value(), 77);
});

test('reported updates during an in-flight batch do not double-count either that batch or the next queued delta', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const rendered = harness({ onWrite: () => ++calls === 1 ? first.promise : second.promise });
  rendered.click(1); rendered.click(1); rendered.click(1);
  await rendered.advance(600);
  rendered.click(1); rendered.click(1);
  assert.equal(rendered.value(), 79);
  await rendered.advance(600);
  rendered.report('target_temperature.heat', 77);
  assert.equal(rendered.value(), 79);
  first.resolve(); await settle();
  assert.equal(rendered.value(), 79);
  assert.deepEqual(rendered.requests.map(request => request.opts.steps), [3, 2]);
  rendered.report('target_temperature.heat', 79);
  second.resolve(); await settle();
  assert.equal(rendered.value(), 79);
});

test('a promise-first completion bridges the preview briefly and reconciles the actual event or expires to reported truth', async () => {
  for (const eventArrives of [true, false]) {
    const pending = deferred();
    const rendered = harness({ onWrite: () => pending.promise });
    rendered.click(1); rendered.click(1); rendered.click(1);
    await rendered.advance(600);
    pending.resolve(); await settle();
    assert.equal(rendered.value(), 77);
    assert.equal(rendered.device.capabilitiesObj['target_temperature.heat'].value, 74);
    await rendered.advance(1499);
    assert.equal(rendered.value(), 77);
    if (eventArrives) {
      rendered.report('target_temperature.heat', 76);
      assert.equal(rendered.value(), 76, 'The actual event wins even if it differs from the completed intent');
    } else {
      await rendered.advance(1);
      assert.equal(rendered.value(), 74, 'An expected value must not remain displayed indefinitely without a capability event');
    }
  }
});

test('promise-before-event handoff preserves the next queued baseline without applying either delta twice', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const rendered = harness({ onWrite: () => ++count === 1 ? first.promise : second.promise });
  rendered.click(1); rendered.click(1); rendered.click(1); await rendered.advance(600);
  rendered.click(1); rendered.click(1); await rendered.advance(600);
  first.resolve(); await settle();
  assert.equal(rendered.value(), 79);
  assert.deepEqual(rendered.requests.map(request => request.opts.steps), [3, 2]);
  rendered.report('target_temperature.heat', 77);
  assert.equal(rendered.value(), 79);
  rendered.report('target_temperature.heat', 79);
  second.resolve(); await settle();
  assert.equal(rendered.value(), 79);
});

test('a rejected batch rolls the preview back to the latest reported target and permits a deliberate retry', async () => {
  const first = deferred();
  let calls = 0;
  const rendered = harness({ onWrite: () => ++calls === 1 ? first.promise : Promise.resolve() });
  rendered.click(1); rendered.click(1);
  assert.equal(rendered.value(), 76);
  await rendered.advance(600);
  rendered.report('target_temperature.heat', 73);
  first.reject(Error('Emulated thermostat rejected this change')); await settle();
  assert.equal(rendered.value(), 73);
  assert.deepEqual(rendered.toasts, ['Emulated thermostat rejected this change']);
  assert.equal(rendered.requests.length, 1);
  rendered.click(1);
  assert.equal(rendered.value(), 74);
});

test('context cancellation resets unsent previews to the reported target and unmount never dispatches them', async () => {
  for (const change of [
    rendered => { rendered.device.settings.temperature_control_units = 'metric'; },
    rendered => { rendered.device.settings.read_only = true; },
    rendered => { rendered.device.available = false; },
    rendered => rendered.report('thermostat_mode', 'heat'),
  ]) {
    const rendered = harness();
    rendered.click(1); rendered.click(1);
    assert.equal(rendered.value(), 76);
    change(rendered); rendered.render();
    assert.equal(rendered.value(), 74);
    await rendered.advance(1000);
    assert.equal(rendered.requests.length, 0);
  }
  const selection = harness();
  selection.click(1);
  nodes(selection.render(), 'selector')[0].props.onSelectionChange('target_temperature.cool');
  assert.equal(selection.value(), 80);
  await selection.advance(1000);
  assert.equal(selection.requests.length, 0);
  const unmounted = harness();
  unmounted.click(1); unmounted.unmount(); await unmounted.advance(1000);
  assert.equal(unmounted.requests.length, 0);
});

test('native dragging previews the latest absolute target and remains ordered before later relative presses', async () => {
  const absolute = deferred(), relative = deferred();
  const rendered = harness({ onWrite: request => request.capabilityId.startsWith('target_temperature') ? absolute.promise : relative.promise });
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(76);
  assert.equal(rendered.value(), 76);
  await rendered.advance(100);
  rendered.click(1);
  assert.equal(rendered.value(), 77);
  await rendered.advance(600);
  assert.equal(rendered.requests.length, 0);
  await rendered.advance(300);
  assert.equal(rendered.requests[0].value, 76);
  rendered.report('target_temperature.heat', 76);
  absolute.resolve(); await settle();
  assert.equal(rendered.value(), 77);
  assert.equal(rendered.requests[1].opts.steps, 1);
  rendered.report('target_temperature.heat', 77);
  relative.resolve(); await settle();
  assert.equal(rendered.value(), 77);
});

test('native paired failure keeps the latest actual target instead of the vendor hook restoring an older captured value', async () => {
  const pending = deferred();
  const rendered = harness({ onWrite: () => pending.promise });
  nodes(rendered.render(), 'dial')[0].props.onTargetValueChange(76);
  await rendered.advance(1000);
  rendered.socketReport('target_temperature.heat', 75);
  assert.equal(rendered.device.capabilitiesObj['target_temperature.heat'].value, 74, 'A socket capability event need not mutate the device metadata snapshot');
  assert.equal(rendered.value(), 75, 'Unchanged stale metadata must not overwrite the actual capability event on rerender');
  pending.reject(Error('The other target was not confirmed')); await settle();
  assert.equal(rendered.value(), 75);
  assert.equal(rendered.device.capabilitiesObj['target_temperature.heat'].value, 74);
  assert.deepEqual(rendered.toasts, ['The other target was not confirmed']);
});

test('socket-only target events remain authoritative across subsequent queued presses and metadata refreshes', async () => {
  const first = deferred(), second = deferred();
  let writes = 0;
  const rendered = harness({ onWrite: () => ++writes === 1 ? first.promise : second.promise });
  rendered.click(1); await rendered.advance(600);
  rendered.socketReport('target_temperature.heat', 75);
  assert.equal(rendered.value(), 75);
  assert.equal(rendered.device.capabilitiesObj['target_temperature.heat'].value, 74);
  rendered.click(1); rendered.click(1);
  assert.equal(rendered.value(), 77);
  await rendered.advance(600);
  first.resolve(); await settle();
  assert.equal(rendered.value(), 77);
  assert.deepEqual(rendered.requests.map(request => request.opts.steps), [1, 2]);
  rendered.socketReport('target_temperature.heat', 77);
  second.resolve(); await settle();
  assert.equal(rendered.value(), 77);
  assert.equal(rendered.device.capabilitiesObj['target_temperature.heat'].value, 74);
  rendered.device.capabilitiesObj['target_temperature.heat'] = { ...rendered.device.capabilitiesObj['target_temperature.heat'], value: 76 };
  assert.equal(rendered.value(), 76, 'A later changed metadata snapshot can reconcile the value even without another socket callback');
});

test('only exact scoped Lennox native hooks suppress optimism and captured-value rollback', async () => {
  for (const capabilityId of ['target_temperature', 'target_temperature.heat', 'target_temperature.cool']) {
    const pending = deferred();
    const rendered = harness({ hookCapability: capabilityId, onWrite: () => pending.promise });
    const initial = rendered.render()[0];
    const action = rendered.render()[1](76);
    assert.equal(rendered.render()[0], initial, 'The local dial preview must not mutate the reported-value hook');
    rendered.report(capabilityId, 75);
    pending.reject(Error('Scoped failure'));
    await assert.rejects(action, /Scoped failure/); await settle();
    assert.equal(rendered.render()[0], 75);
  }
  for (const options of [
    { driverId: 'homey:app:other.vendor:thermostat', hookCapability: 'target_temperature.heat' },
    { hookCapability: 'target_temperature.extra' },
    { hookCapability: 'target_temperature.heat', requestTimeout: null },
  ]) {
    const pending = deferred();
    const rendered = harness({ ...options, onWrite: () => pending.promise });
    const action = rendered.render()[1](76);
    assert.equal(rendered.render()[0], 76, 'Ordinary hooks retain their original optimistic behavior');
    pending.reject(Error('Ordinary failure'));
    await assert.rejects(action, /Ordinary failure/); await settle();
    assert.equal(rendered.render()[0], 74);
  }
});

test('the preview presentation layer preserves the exact previous layer for rollback', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Requires the reviewed vendor bundle',
}, () => {
  const selected = Buffer.from(selection(icons(fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE, 'utf8'))));
  const previous = patches.patchCoalescedBundle(controls(selected).output).output;
  const { output, report } = patches.patchPreviewBundle(previous);
  assert.equal(report.replacements, 2);
  const deployment = fs.readFileSync(`${__dirname}/../scripts/manage-homey-web-preview.py`, 'utf8');
  const deploymentConstant = name => {
    const match = deployment.match(new RegExp(`^${name} = "([a-f0-9]{64})"$`, 'm'));
    assert.ok(match, `The deployment wrapper must pin a complete ${name} checksum`);
    return match[1];
  };
  assert.equal(deploymentConstant('ORIGINAL_SHA256'), patches.PREVIEW_EXPECTED_SHA256);
  assert.equal(deploymentConstant('PATCHED_SHA256'), createHash('sha256').update(output).digest('hex'), 'Deployment must accept the exact tested artifact');
  assert.equal(deploymentConstant('GUARDS_SHA256'), '677f7c8e9d3c528273ab1b40aa3b1d9f095f30a95021510210c1d150bf03d10d', 'The previously reviewed deployment guards remain pinned');
  assert.equal(deploymentConstant('GUARDS_SHA256'), createHash('sha256').update(fs.readFileSync(`${__dirname}/../scripts/manage-homey-web-icons.py`)).digest('hex'));
  assert.equal(output.toString().replace(patches.PREVIEW_AFTER, patches.COALESCED_AFTER).replace(patches.PREVIEW_HOOK_AFTER, patches.COALESCED_HOOK_AFTER), previous.toString());
  assert.equal(patches.transformPreviewSource(patches.COALESCED_HOOK_AFTER + '\n' + patches.COALESCED_AFTER), patches.PREVIEW_HOOK_AFTER + '\n' + patches.PREVIEW_AFTER);
  assert.throws(() => patches.transformPreviewSource(''), /found 0/);
  assert.throws(() => patches.transformPreviewSource(patches.COALESCED_HOOK_AFTER + '\n' + patches.COALESCED_AFTER + patches.COALESCED_AFTER), /found 2/);
  assert.throws(() => patches.transformPreviewSource(patches.PREVIEW_HOOK_AFTER + '\n' + patches.PREVIEW_AFTER), /found 0/);
});
