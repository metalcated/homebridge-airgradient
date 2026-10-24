const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { JSDOM } = require('jsdom');
const waitFor = async predicate => { const until = Date.now() + 2000; while (!predicate()) { if (Date.now() > until) { throw Error('UI wait timed out'); } await new Promise(r => setTimeout(r, 5)); } };

async function ui(initialBlocks = [{ platform: 'AirGradientPlatform', sensors: [{ serialno: 'abc123', host: '192.168.1.2' }] }], dark = false) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/index.html'), 'utf8'), { runScripts: 'outside-only' });
  const { window } = dom; const doc = window.document; const modal = doc.getElementById('add-dialog');
  modal.showModal = () => modal.open = true; modal.close = () => modal.open = false;
  let blocks = initialBlocks;
  if (dark) { doc.body.classList.add('dark-mode'); }
  let schemaConfigCount = 0;
  const requests = []; const events = {}; let fail = false; let updates = 0;
  window.homebridge = {
    getPluginConfig: async () => JSON.parse(JSON.stringify(blocks)),
    updatePluginConfig: async value => { blocks = value; updates++; },
    showSchemaForm: () => { schemaConfigCount = blocks.length; }, addEventListener: (name, fn) => events[name] = fn,
    request: async (route, payload) => {
      requests.push({ route, payload }); if (fail) { throw new Error('Emulated connection failure'); }
      if (route === '/discover') { return [{ serialno: 'new123', host: 'monitor.local', port: 8080, model: '<img src=x onerror=alert(1)>' }]; }
      if (route === '/probe') { return { serialno: payload.serialno, model: 'ONE', firmware: '3.1.9', apiVersion: 'legacy', measurements: ['pm02'] }; }
      if (route === '/diagnostics') { return { serialno: payload.serialno, values: { pm02: 7 }, ageSeconds: 12, failures: 0, readingTimes: { 'PM2.5': Date.now() } }; }
      if (route === '/history') { return [{ time: Date.now(), pm02: 7, rco2: 500 }]; }
    },
  };
  window.eval(fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/app.js'), 'utf8'));
  await waitFor(() => doc.querySelector('#sensor option'));
  const click = async id => { doc.getElementById(id).click(); await waitFor(() => doc.getElementById('status').textContent !== 'Working…'); };
  return { dom, doc, click, requests, events, modal, get blocks() { return blocks; }, get updates() { return updates; }, get schemaConfigCount() { return schemaConfigCount; }, set fail(v) { fail = v; } };
}

test('settings UI: discover, cancel, approve, duplicate, failure/retry, edit and reopen', async () => {
  const h = await ui();
  try {
    await h.click('discover'); assert.equal(h.updates, 0); assert.equal(h.doc.querySelectorAll('#found img').length, 0);
    h.doc.querySelector('#found button').click(); assert.equal(h.modal.open, true);
    await h.click('cancel-add'); assert.equal(h.updates, 0);
    h.doc.querySelector('#found button').click(); h.fail = true; await h.click('confirm-add');
    assert.match(h.doc.getElementById('status').textContent, /connection failure/); assert.equal(h.updates, 0);
    h.fail = false; await h.click('confirm-add'); assert.equal(h.updates, 1); assert.equal(h.blocks[0].sensors.length, 2);
    h.doc.querySelector('#found button').click(); await h.click('confirm-add'); assert.equal(h.updates, 1);
    assert.match(h.doc.getElementById('status').textContent, /already configured/);
    await h.click('cancel-add'); await h.click('probe'); assert.match(h.doc.getElementById('report').textContent, /ONE/);
    h.events.configChanged({ data: [{ platform: 'AirGradientPlatform', sensors: [{ serialno: 'edited456' }] }] });
    await h.click('probe'); assert.equal(h.requests.at(-1).payload.serialno, 'edited456');
    const reopened = await ui(); assert.equal(reopened.doc.getElementById('sensor').options.length, 1); reopened.dom.window.close();
  } finally { h.dom.window.close(); }
});

test('settings UI: diagnostics and history remain readable without browser storage or prompts', async () => {
  const h = await ui();
  try {
    h.dom.window.alert = h.dom.window.confirm = h.dom.window.prompt = () => { throw Error('Browser prompt used'); };
    await h.click('diagnostics'); assert.match(h.doc.getElementById('report').textContent, /12/);
    await h.click('history'); assert.match(h.doc.getElementById('report').textContent, /500/);
    h.fail = true; await h.click('diagnostics'); assert.match(h.doc.getElementById('status').textContent, /connection failure/);
    assert.equal(h.doc.getElementById('diagnostics').disabled, false);
    assert(!fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/app.js'), 'utf8').includes('localStorage'));
  } finally { h.dom.window.close(); }
});

test('UI backend only exposes diagnostics/history for configured sensors and excludes secrets', async () => {
  const Module = require('node:module'); const original = Module._load;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airgradient-ui-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ platforms: [{ platform: 'AirGradientPlatform', sensors: [{ serialno: 'abc123' }] }] }));
  class Server { constructor() { this.homebridgeStoragePath = root; this.routes = {}; } onRequest(route, fn) { this.routes[route] = fn; } ready() {} }
  Module._load = function(name, parent, main) { if (name === '@homebridge/plugin-ui-utils') { return { HomebridgePluginUiServer: Server, RequestError: Error }; } return original.call(this, name, parent, main); };
  let UiServer; try { ({ UiServer } = require('../homebridge-ui/server')); } finally { Module._load = original; }
  const server = new UiServer();
  await assert.rejects(server.routes['/diagnostics']({ serialno: '../abc' }), /not in the saved/);
  assert.equal(await server.routes['/diagnostics']({ serialno: 'abc123' }), null);
  assert.deepEqual(await server.routes['/history']({ serialno: 'abc123' }), []);
  await assert.rejects(server.routes['/probe']({ serialno: 'abc123', host: 'http://localhost/secret' }), /Host/);
});

test('real UI server IPC: probe, saved-config authorization and diagnostics across reopen', async t => {
  const { fork } = require('node:child_process'); const { emulator } = require('./emulator.cjs');
  const { SensorStore } = require('../dist/storage');
  const device = await emulator('v1'); t.after(device.close);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airgradient-ipc-'));
  const configPath = path.join(root, 'custom-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ platforms: [{ platform: 'AirGradientPlatform', sensors: [device.settings] }] }));
  const store = new SensorStore(root); store.diagnostics('abc123', { serialno: 'abc123', values: { rco2: 600 }, lastSuccess: Date.now() }); store.close();
  async function open() {
    const child = fork(path.join(__dirname, '../homebridge-ui/server.js'), [], { env: { ...process.env,
      HOMEBRIDGE_STORAGE_PATH: root, HOMEBRIDGE_CONFIG_PATH: configPath }, stdio: ['ignore','pipe','pipe','ipc'] });
    let errorOutput = ''; child.stderr.on('data', chunk => errorOutput += chunk);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`UI server did not become ready: ${errorOutput}`)), 3000);
      child.on('message', message => { if (message.action === 'ready') { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`UI server exited ${code}: ${errorOutput}`)); });
    });
    t.after(() => { if (child.connected) { child.disconnect(); } });
    return { child, request: (route, body) => new Promise((resolve, reject) => {
      const requestId = Math.random().toString(); const timer = setTimeout(() => reject(Error('IPC timed out')), 3000);
      const listener = message => {
        if (message.action === 'response' && message.payload.requestId === requestId) {
          clearTimeout(timer); child.off('message', listener); resolve(message.payload);
        }
      };
      child.on('message', listener); child.send({ action: 'request', requestId, path: route, body });
    }) };
  }
  const first = await open();
  const probe = await first.request('/probe', device.settings); assert.equal(probe.success, true); assert.equal(probe.data.apiVersion, 'v1');
  const denied = await first.request('/diagnostics', { serialno: 'unconfigured' }); assert.equal(denied.success, false);
  const data = await first.request('/diagnostics', { serialno: 'abc123' }); assert.equal(data.data.values.rco2, 600);
  assert(!JSON.stringify(data).includes('127.0.0.1')); first.child.disconnect();
  const second = await open(); const reopened = await second.request('/diagnostics', { serialno: 'abc123' });
  assert.equal(reopened.success, true); assert.equal(reopened.data.values.rco2, 600);
});

test('cancelling while the discovery connection check is pending never stages a monitor', async () => {
  const h = await ui();
  try {
    await h.click('discover'); h.doc.querySelector('#found button').click();
    const original = h.dom.window.homebridge.request; let release;
    h.dom.window.homebridge.request = async (route, payload) => {
      if (route === '/probe') { await new Promise(resolve => release = resolve); }
      return original(route, payload);
    };
    h.doc.getElementById('confirm-add').click(); await waitFor(() => release);
    assert.equal(h.doc.getElementById('confirm-add').disabled, true);
    h.doc.getElementById('cancel-add').click(); release();
    await waitFor(() => h.doc.getElementById('status').textContent !== 'Working…');
    assert.equal(h.updates, 0); assert.match(h.doc.getElementById('status').textContent, /cancelled/);
  } finally { h.dom.window.close(); }
});


for (const dark of [false, true]) {
  test(`first-time setup in ${dark ? 'dark' : 'light'} mode stages the schema and disables unavailable actions`, async () => {
    const h = await ui([], dark);
    try {
      assert.equal(h.updates, 1);
      assert.deepEqual(JSON.parse(JSON.stringify(h.blocks)), [{ platform: 'AirGradientPlatform', sensors: [] }]);
      assert.equal(h.schemaConfigCount, 1);
      assert.equal(h.doc.getElementById('sensor').disabled, true);
      assert.equal(h.doc.getElementById('sensor').options[0].textContent, 'No monitors configured');
      assert.equal(h.doc.getElementById('empty-state').hidden, false);
      for (const id of ['probe', 'diagnostics', 'history', 'export']) { assert.equal(h.doc.getElementById(id).disabled, true); }
      await h.click('discover'); assert.equal(h.doc.getElementById('probe').disabled, true);
      h.doc.querySelector('#found button').click(); await h.click('confirm-add');
      assert.equal(h.doc.getElementById('sensor').disabled, false);
      assert.equal(h.doc.getElementById('empty-state').hidden, true);
      assert.equal(h.doc.getElementById('probe').disabled, false);
      // Removing the final monitor through the schema returns to the empty state.
      h.events.configChanged({ data: [{ platform: 'AirGradientPlatform', sensors: [] }] });
      assert.equal(h.doc.getElementById('probe').disabled, true);
    } finally { h.dom.window.close(); }
  });
}
