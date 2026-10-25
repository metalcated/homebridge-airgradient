'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ManagedS30API } = require('../lib/transport');
const { SessionManager } = require('../lib/session');
const { normalizeZone } = require('../lib/model');
const { createEmulator } = require('./emulator.cjs');

const SERIAL = 'EMU-S40-001';
const cases = [
  { type: 'heat', key: 'hsp', value: 21, fahrenheit: 70, mode: 'heat', single: false },
  { type: 'cool', key: 'csp', value: 24, fahrenheit: 75, mode: 'cool', single: false },
  { type: 'target', key: 'sp', value: 23, fahrenheit: 73, mode: 'heat', single: true },
];

async function rig({ key, mode, single }, reported, contradictory = false, reportOverride) {
  const emulator = await createEmulator({ singleSetpoint: single, period: { systemMode: mode } });
  const api = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 300 });
  const rawPeriods = [];
  const logs = [];
  const processMessage = api.processMessage.bind(api);
  api.processMessage = message => {
    for (const zone of message.Data?.zones ?? []) {
      if (zone.id === 0 && zone.status?.period) rawPeriods.push(structuredClone(zone.status.period));
    }
    return processMessage(message);
  };
  const originalPeriod = structuredClone(emulator.state.zones[0].status.period);
  const publish = api.publishMessage.bind(api);
  let postPublishIndex;
  api.publishMessage = async (...args) => {
    await publish(...args);
    // Serve actual HTTP notifications containing only one reported unit. The
    // missing counterpart is omitted, not null-cleared or edited in the parser.
    const snapshot = structuredClone(emulator.state);
    const period = snapshot.zones[0].status.period;
    const omitted = reported === 'F' ? key + 'C' : key;
    if (contradictory) period[omitted] = originalPeriod[omitted];
    else delete period[omitted];
    if (reportOverride) period[reported === 'F' ? key : key + 'C'] = reportOverride.value;
    for (const session of emulator.sessions.values()) session.queue.length = 0;
    postPublishIndex = rawPeriods.length;
    emulator.setBehavior('requestData', { snapshot });
    emulator.enqueue(snapshot);
  };
  const manager = new SessionManager({ clientFactory: () => api, pollMs: 2, drainMs: 1,
    connectTimeoutMs: 500, catalogSettleMs: 5, confirmTimeoutMs: 60, commandTimeoutMs: 500,
    log: (message, detail) => logs.push({ message, detail }) });
  return { api, emulator, manager, originalPeriod, logs,
    reports: () => rawPeriods.slice(postPublishIndex),
    async close() { await manager.close(); await emulator.close(); } };
}

function readbackLog(fixture, item, reported, outcome) {
  const entries = fixture.logs.filter(entry => entry.message === 'Lennox temperature readback');
  assert.equal(entries.length, 1, 'Log once at completion rather than once per retry');
  const detail = entries[0].detail;
  assert.deepEqual(Object.keys(detail).sort(), [
    'outcome', 'target', 'units', 'expectedC', 'expectedF', 'parsedC', 'parsedF',
    'targetReportRevision', 'reportedCPresent', 'reportedFPresent', 'reportedC', 'reportedF',
    'publishStatus', 'publishCode',
  ].sort());
  assert.equal(detail.outcome, outcome);
  assert.equal(detail.target, item.type);
  assert.equal(detail.units, reported === 'F' ? 'imperial' : 'metric');
  assert.equal(detail.expectedC, item.value);
  assert.equal(detail.expectedF, item.fahrenheit);
  assert.equal(detail.publishStatus, 204);
  assert.equal(detail.publishCode, null);
  assert.ok(Number.isInteger(detail.targetReportRevision) && detail.targetReportRevision > 0);
  const text = JSON.stringify(detail);
  assert.ok(text.length < 512, 'The diagnostic must stay bounded');
  for (const privateValue of [SERIAL, fixture.emulator.host, 'Living Room', 'Bedroom']) assert.equal(text.includes(privateValue), false);
  return detail;
}

for (const item of cases) {
  for (const reported of ['F', 'C']) {
    test(`a fresh ${reported}-only ${item.type} report confirms the actual target without retaining an omitted stale counterpart`, async () => {
      const fixture = await rig(item, reported);
      const units = reported === 'F' ? 'imperial' : 'metric';
      let state, failure;
      try {
        try { state = await fixture.manager.command(fixture.emulator.host, SERIAL, 0, { type: item.type, value: item.value, units }, false); }
        catch (error) { failure = error; }
        const actual = fixture.emulator.state.zones[0].status.period;
        assert.equal(actual[item.key], item.fahrenheit, 'The thermostat emulator actually applied the requested native Fahrenheit value');
        assert.equal(actual[item.key + 'C'], item.value);
        const reports = fixture.reports();
        assert.ok(reports.length > 0, 'Post-publish readback must arrive through the actual HTTP parser');
        const observed = reported === 'F' ? item.key : item.key + 'C';
        const omitted = reported === 'F' ? item.key + 'C' : item.key;
        assert.ok(reports.every(period => Number.isFinite(period[observed]) && !Object.hasOwn(period, omitted)), 'The counterpart must be absent on the wire, rather than null-cleared by the fixture');
        assert.equal(fixture.emulator.events.filter(event => event.route === 'publish').length, 1);
        assert.ifError(failure);
        const detail = readbackLog(fixture, item, reported, 'confirmed');
        assert.equal(detail.reportedFPresent, reported === 'F');
        assert.equal(detail.reportedCPresent, reported === 'C');
        assert.equal(detail.reportedF, reported === 'F' ? item.fahrenheit : null);
        assert.equal(detail.reportedC, reported === 'C' ? item.value : null);
        assert.equal(detail.parsedF, reported === 'F' ? item.fahrenheit : null, 'The parser must not retain a stale unreported Fahrenheit value');
        assert.equal(detail.parsedC, reported === 'C' ? item.value : null, 'The parser must not retain a stale unreported Celsius value');
        const normalized = state[item.type === 'target' ? 'target_temperature' : item.type + '_target'];
        if (reported === 'F') assert.equal(Math.round(normalized * 9 / 5 + 32), item.fahrenheit);
        else assert.equal(normalized, item.value);
      } finally { await fixture.close(); }
    });

    test(`contradictory simultaneously reported ${reported}/${reported === 'F' ? 'C' : 'F'} fields cannot confirm a ${item.type} change`, async () => {
      const fixture = await rig(item, reported, true);
      try {
        await assert.rejects(fixture.manager.command(fixture.emulator.host, SERIAL, 0,
          { type: item.type, value: item.value, units: reported === 'F' ? 'imperial' : 'metric' }, false), /did not confirm/);
        const reports = fixture.reports();
        assert.ok(reports.length > 0);
        assert.ok(reports.every(period => Object.hasOwn(period, item.key) && Object.hasOwn(period, item.key + 'C')));
        assert.equal(fixture.emulator.events.filter(event => event.route === 'publish').length, 1);
        const detail = readbackLog(fixture, item, reported, 'unconfirmed');
        assert.equal(detail.reportedFPresent, true);
        assert.equal(detail.reportedCPresent, true);
        assert.equal(detail.parsedF, detail.reportedF);
        assert.equal(detail.parsedC, detail.reportedC);
      } finally { await fixture.close(); }
    });
  }
}

test('fan-only period reports preserve the last target field provenance and do not clear either unit', async () => {
  const emulator = await createEmulator();
  const api = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 300 });
  try {
    await api.serverConnect();
    const system = api.getSystem('LCC');
    await api.subscribe(system);
    await api.messagePump();
    const previous = structuredClone(api.targetReports.get(0));
    const revision = api.periodReportRevision;
    emulator.enqueue({ zones: [{ id: 0, status: { period: { fanMode: 'on' } } }] });
    await api.messagePump();
    assert.ok(api.periodReportRevision > revision);
    assert.deepEqual(api.targetReports.get(0), previous);
    const zone = system.zones.find(item => item.id === 0);
    assert.equal(zone.hsp, 68);
    assert.equal(zone.hspC, 20);
    assert.equal(zone.csp, 77);
    assert.equal(zone.cspC, 25);
  } finally { await api.close(); await emulator.close(); }
});

test('two serialized Fahrenheit adjustments use fresh F-only readback and update the displayed target through conversion', async () => {
  const fixture = await rig(cases[0], 'F');
  try {
    const states = await Promise.all([1, 2].map(() => fixture.manager.command(fixture.emulator.host, SERIAL, 0,
      { type: 'adjust', target: 'heat', direction: 1, units: 'imperial' }, false)));
    const writes = fixture.emulator.events.filter(event => event.route === 'publish');
    assert.deepEqual(writes.map(event => event.data.Data.schedules[0].schedule.periods[0].period.hsp), [69, 70]);
    assert.deepEqual(states.map(state => Math.round(state.heat_target * 9 / 5 + 32)), [69, 70]);
    assert.ok(Math.abs(states[0].heat_target - (69 - 32) * 5 / 9) < 1e-9);
    assert.ok(Math.abs(states[1].heat_target - (70 - 32) * 5 / 9) < 1e-9);
    assert.equal(fixture.emulator.state.zones[0].status.period.csp, 77);
    assert.equal(fixture.emulator.state.zones[1].status.period.hsp, 68);
    assert.equal(fixture.logs.filter(entry => entry.message === 'Lennox temperature readback').length, 2);
  } finally { await fixture.close(); }
});

test('a null or malformed single-unit target report cannot reuse its omitted cached counterpart to confirm or display a target', async () => {
  for (const item of cases) {
    for (const reported of ['F', 'C']) {
      for (const value of [null, 'invalid', { invalid: true }]) {
        const fixture = await rig(item, reported, false, { value });
        try {
          await assert.rejects(fixture.manager.command(fixture.emulator.host, SERIAL, 0,
            { type: item.type, value: item.value, units: reported === 'F' ? 'imperial' : 'metric' }, false), /did not confirm/);
          const system = fixture.api.getSystem('LCC'), zone = system.zones.find(entry => entry.id === 0);
          const normalized = normalizeZone(system, zone);
          assert.equal(normalized[item.type === 'target' ? 'target_temperature' : item.type + '_target'], undefined);
          const detail = readbackLog(fixture, item, reported, 'unconfirmed');
          assert.equal(detail.reportedFPresent, reported === 'F');
          assert.equal(detail.reportedCPresent, reported === 'C');
          assert.equal(detail.reportedF, null);
          assert.equal(detail.reportedC, null);
          assert.equal(detail.parsedF, null);
          assert.equal(detail.parsedC, null);
          assert.equal(fixture.emulator.events.filter(event => event.route === 'publish').length, 1);
        } finally { await fixture.close(); }
      }
    }
  }
});

test('publish acknowledgement diagnostics record bounded status/code without changing ordinary ACK acceptance', async () => {
  const emulator = await createEmulator();
  const api = new ManagedS30API({ host: emulator.host, port: emulator.port, protocol: emulator.protocol, requestTimeoutMs: 50 });
  try {
    await api.serverConnect();
    const system = api.getSystem('LCC');
    await api.subscribe(system);
    await api.messagePump();
    const data = { schedules: [{ id: 16, schedule: { periods: [{ id: 0, period: { hspC: 21, hsp: 70 } }] } }] };
    for (const [behavior, code] of [
      [{ status: 200, body: { code: 1, privatePayload: SERIAL } }, 1],
      [{ status: 200, body: { code: 0 } }, 0],
      [{ status: 200, body: { code: '1' } }, null],
      [{ status: 200, body: 'malformed-json' }, null],
      [{ status: 204 }, null],
    ]) {
      emulator.setBehavior('publish', behavior);
      await api.publishMessage('LCC', data);
      assert.deepEqual(api.lastPublishAcknowledgement, { status: behavior.status, code });
      assert.equal(JSON.stringify(api.lastPublishAcknowledgement).includes(SERIAL), false);
    }
    emulator.setBehavior('publish', { status: 500, body: { code: 7 } });
    await assert.rejects(api.publishMessage('LCC', data), /Publish failed/);
    assert.deepEqual(api.lastPublishAcknowledgement, { status: 500, code: 7 });
    await api.requestDataHelper('LCC', '1;/zones');
    assert.deepEqual(api.lastPublishAcknowledgement, { status: 500, code: 7 }, 'A later non-publish response must not overwrite command diagnostics');
    emulator.setBehavior('publish', { hang: true });
    await assert.rejects(api.publishMessage('LCC', data));
    assert.equal(api.lastPublishAcknowledgement, null, 'A failed new request must not retain the preceding ACK');
  } finally { await api.close(); await emulator.close(); }
});
