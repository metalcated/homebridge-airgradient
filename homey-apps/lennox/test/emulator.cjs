'use strict';

const http = require('node:http');
const https = require('node:https');

// Public test-only key/certificate for the loopback emulator. Never use these
// credentials outside tests; no real thermostat identity or secret is present.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgE2dAPjoBrUFi45uM
wElarJtYQsNiv83czPKcKZ/ly8GhRANCAAQAZ1lJ0/PhzSeb5KjJAtqUyn+L1dWa
WMZCJ/p3trncBGiqVMsYfeR2faHl9wwE26iUlIHIdyQUVHDw1iPodsnj
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBfzCCASWgAwIBAgIUT6bD3RSLPF48ECZfLGEhS39rmUgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNTAwMDkzNloYDzIxMjYxMDAx
MDAwOTM2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQAZ1lJ0/PhzSeb5KjJAtqUyn+L1dWaWMZCJ/p3trncBGiqVMsYfeR2
faHl9wwE26iUlIHIdyQUVHDw1iPodsnjo1MwUTAdBgNVHQ4EFgQUMgQwb8gxZekC
R/BgTmXRHx5X54swHwYDVR0jBBgwFoAUMgQwb8gxZekCR/BgTmXRHx5X54swDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA08b+gebETCgY4KYzc1xB
jjNRwsb2zhWFyWct/Vd2FkUCIFdz4d/a+9kbNFBDPMUUliSs6cPvW7bGWxm4qbRr
DMbx
-----END CERTIFICATE-----`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeZone(id, options = {}) {
  return {
    id,
    config: {
      name: id === 0 ? 'Living Room' : 'Bedroom',
      heatingOption: true,
      coolingOption: true,
      humidificationOption: true,
      dehumidificationOption: true,
      emergencyHeatingOption: true,
      minHsp: 50,
      maxHsp: 90,
      minHspC: 10,
      maxHspC: 32,
      minCsp: 60,
      maxCsp: 95,
      minCspC: 15.5,
      maxCspC: 35,
      minHumSp: 15,
      maxHumSp: 50,
      minDehumSp: 35,
      maxDehumSp: 60,
      scheduleId: 16 + id,
    },
    status: {
      temperature: 72,
      temperatureC: 22,
      temperatureStatus: 'good',
      humidity: 43,
      humidityStatus: 'good',
      tempOperation: 'off',
      humOperation: 'off',
      fan: false,
      demand: 0,
      period: {
        hsp: 68,
        hspC: 20,
        csp: 77,
        cspC: 25,
        sp: 72,
        spC: 22,
        husp: 38,
        desp: 52,
        humidityMode: 'both',
        systemMode: 'heat and cool',
        fanMode: 'auto',
        startTime: 0,
        overrideActive: false,
        vendorExtension: 'keep-this-field',
        ...options.period,
      },
    },
    scheduleHold: { enabled: false, scheduleId: 16 + id, overrideActive: false },
  };
}

function makeSnapshot(options = {}) {
  return {
    system: {
      config: {
        name: 'Emulated Lennox',
        temperatureUnit: 'F',
        centralMode: false,
        numberOfZones: options.zones ?? 2,
        allergenDefender: false,
        ventilationMode: 'off',
        circulateTime: 25,
        options: {
          productType: options.model ?? 'S40',
          ventilation: { unitType: 'erv', controlMode: 'manual' },
        },
        vendorExtension: 'keep-system-config',
      },
      registration: { serialNumber: options.serial ?? 'EMU-S40-001', productType: options.model ?? 'S40' },
      status: {
        outdoorTemperature: 50,
        outdoorTemperatureC: 10,
        outdoorTemperatureStatus: 'good',
        zoningMode: options.central ? 'central' : 'zoned',
      },
    },
    zones: Array.from({ length: options.zones ?? 2 }, (_, id) => makeZone(id, options)),
    equipments: [{ id: 0, equipment: { parameters: [{ id: 1, parameter: { pid: 525, value: options.singleSetpoint ? '1' : '0' } }] } }],
    devices: [{ id: 0, device: { serialNumber: options.serial ?? 'EMU-S40-001', productType: options.model ?? 'S40', softwareVersion: 'emulated-1.0' } }],
    schedules: [{ id: 0, schedule: { name: 'Weekday', periods: [] } }],
    occupancy: { manualAway: false, smartAway: { config: { enabled: false }, status: { state: 'disabled', setpointState: 'home' } } },
  };
}

/**
 * Loopback Lennox wire-protocol emulator. Only tests instantiate this server.
 * It never connects to a thermostat or forwards a request outside loopback.
 */
async function createEmulator(options = {}) {
  const state = makeSnapshot(options);
  const events = [];
  const sessions = new Map();
  const behaviors = new Map();
  const sockets = new Set();
  const timers = new Set();
  let closed = false;

  function enqueue(session, data = state) {
    session.queue.push({
      MessageID: String(session.sequence++),
      SenderID: options.senderId ?? 'LCC',
      TargetID: session.id,
      MessageType: 'Notification',
      Data: clone(data),
    });
  }

  function publish(data) {
    if (data.resetLcc) throw new Error('Device resets are prohibited in the emulator');
    if (data.system?.config) Object.assign(state.system.config, clone(data.system.config));
    if (data.occupancy?.manualAway !== undefined) state.occupancy.manualAway = data.occupancy.manualAway;
    for (const update of data.zones ?? []) {
      const zone = state.zones.find(entry => entry.id === update.id);
      if (!zone) continue;
      if (update.config) {
        Object.assign(zone.config, clone(update.config));
        if (update.config.scheduleId !== undefined) zone.scheduleHold.scheduleId = update.config.scheduleId;
      }
      if (update.scheduleHold) Object.assign(zone.scheduleHold, clone(update.scheduleHold));
    }
    for (const schedule of data.schedules ?? []) {
      let zones;
      if (schedule.id === 3) zones = state.zones;
      else zones = state.zones.filter(zone => 16 + zone.id === schedule.id);
      for (const period of schedule.schedule?.periods ?? []) {
        if (period.id !== 0) continue;
        for (const zone of zones) Object.assign(zone.status.period, clone(period.period));
      }
    }
    if (!options.ignoreCommands) for (const session of sessions.values()) enqueue(session);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname.endsWith('/Connect') ? 'connect'
      : url.pathname.endsWith('/Disconnect') ? 'disconnect'
        : url.pathname.endsWith('/Retrieve') ? 'retrieve'
          : url.pathname === '/Messages/RequestData' ? 'requestData'
            : url.pathname === '/Messages/Publish' ? 'publish' : 'unknown';
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const body = Buffer.concat(buffers).toString('utf8');
    let data;
    try { data = body ? JSON.parse(body) : undefined; } catch { data = body; }
    events.push({ route, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), data });
    const behavior = behaviors.get(route);
    if (behavior?.hang) return;
    if (behavior?.delayMs) await new Promise(resolve => {
      const timer = setTimeout(() => { timers.delete(timer); resolve(); }, behavior.delayMs);
      timers.add(timer);
    });
    if (closed || res.destroyed) return;

    function respond(status, payload) {
      res.statusCode = behavior?.status ?? status;
      const result = behavior?.body !== undefined ? behavior.body : payload;
      if (res.statusCode === 204) return res.end();
      const text = typeof result === 'string' ? result : JSON.stringify(result ?? {});
      res.setHeader('Content-Type', 'application/json');
      if (options.ambiguousHeaders) {
        res.setHeader('Content-Length', Buffer.byteLength(text));
        res.setHeader('Transfer-Encoding', 'chunked');
      }
      res.end(text);
    }

    const id = url.pathname.split('/')[2];
    if (route === 'connect') {
      sessions.set(id, { id, queue: [], sequence: 1 });
      return respond(204);
    }
    if (route === 'disconnect') {
      sessions.delete(id);
      return respond(204);
    }
    const sender = data?.SenderID;
    const session = sessions.get(route === 'retrieve' ? id : sender);
    if (!session && route !== 'unknown') return respond(401, { error: 'Unknown local connection' });
    if (route === 'requestData') {
      if (data.TargetID !== 'LCC' || data.MessageType !== 'RequestData') return respond(400, { error: 'Invalid RequestData' });
      if (!options.noInitialData) enqueue(session);
      return respond(204);
    }
    if (route === 'retrieve') {
      const messages = session.queue.splice(0, Number(url.searchParams.get('MessageCount')) || 10);
      return messages.length ? respond(200, { messages }) : respond(204);
    }
    if (route === 'publish') {
      if (data.TargetID !== 'LCC' || data.MessageType !== 'Command') return respond(400, { error: 'Invalid Command' });
      if (behavior?.status && ![200, 204].includes(behavior.status)) return respond(behavior.status);
      try { if (!options.ignoreCommands) publish(data.Data); } catch (error) { return respond(400, { error: error.message }); }
      return respond(204);
    }
    return respond(404, { error: 'Unknown endpoint' });
  };
  const server = options.tls
    ? https.createServer({ key: TEST_KEY, cert: TEST_CERT }, handler)
    : http.createServer(handler);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    host: '127.0.0.1',
    port: server.address().port,
    protocol: options.tls ? 'https' : 'http',
    state,
    events,
    sessions,
    setBehavior(route, behavior) { behavior ? behaviors.set(route, behavior) : behaviors.delete(route); },
    enqueue(data = state) { for (const session of sessions.values()) enqueue(session, data); },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createEmulator, makeSnapshot, makeZone };
