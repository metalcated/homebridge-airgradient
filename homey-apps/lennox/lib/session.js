'use strict';

const { ManagedS30API } = require('./transport');
const { validateHost, normalizeZone, candidate, planCommand } = require('./model');
const REFRESH_PATH = '1;/zones;/systemController;/systemControl;/equipments';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class Session {
  constructor(manager, host) {
    this.manager = manager; this.host = host; this.listeners = new Set();
    this.queue = Promise.resolve(); this.stopped = false; this.readyState = false;
    this.lastRefresh = 0; this.lastData = 0; this.retryCount = 0; this.holds = 0;
    this.zoneData = new Map();
  }

  exclusive(work) {
    const result = this.queue.then(() => {
      if (this.stopped) throw Error('Connection closed');
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async connect() {
    if (this.readyState) return;
    await this.api?.close();
    if (this.stopped) throw Error('Connection closed');
    this.zoneData.clear();
    this.api = this.manager.clientFactory({ host: this.host });
    const api = this.api;
    await api.serverConnect();
    this.system = api.getSystem('LCC');
    if (!this.system) throw Error('Thermostat did not provide a local system');
    await api.subscribe(this.system);
    const until = this.manager.now() + this.manager.connectTimeoutMs;
    while (!this.stopped && this.manager.now() < until) {
      const updated = await api.messagePump();
      this.noteData();
      const system = this.system;
      // Subscribe responses arrive in several messages. Drain them through an
      // idle response before fixing the initial list of zones/capabilities.
      if (!updated && typeof system.serialNumber === 'string' && system.serialNumber.trim() &&
        system.zones.some(zone => !zone.isZoneDisabled && normalizeZone(system, zone).measure_temperature !== undefined) &&
        system.zones.filter(zone => !zone.isZoneDisabled && zone.name != null).every(zone =>
          typeof zone.heatingOption === 'boolean' && typeof zone.coolingOption === 'boolean')) {
        this.readyState = true; this.lastData = this.manager.now(); this.lastRefresh = this.lastData;
        this.retryCount = 0;
        this.emit();
        return;
      }
      await this.manager.sleep(this.manager.pollMs);
    }
    throw Error('Thermostat did not provide its identity and zone readings in time');
  }

  zone(serial, zoneId) {
    if (!this.readyState || this.system.serialNumber !== serial) throw Error('Thermostat identity does not match the paired device. Repair the device to check its address.');
    const zone = this.system.zones.find(item => item.id === zoneId && !item.isZoneDisabled);
    if (!zone) throw Error('The paired thermostat zone is unavailable');
    return zone;
  }

  emit() {
    for (const listener of this.listeners) {
      try {
        const zone = this.zone(listener.serial, listener.zoneId);
        const state = normalizeZone(this.system, zone);
        if (state.measure_temperature === undefined) throw Error('Temperature reading is unavailable');
        if (this.manager.now() - (this.zoneData.get(zone.id)?.time ?? 0) > this.manager.staleMs) throw Error('This zone’s temperature reading is stale');
        if (state.thermostat_mode === undefined) throw Error('This thermostat mode is not supported; check the thermostat');
        listener.onState(state, candidate(this.system, zone, this.host));
      } catch (error) { listener.onUnavailable(error.message); }
    }
  }

  unavailable(message) {
    for (const listener of this.listeners) listener.onUnavailable(message);
  }

  noteData() {
    const revisions = this.api.temperatureRevisions || this.api.zoneRevisions;
    if (!revisions) return;
    for (const [id, revision] of revisions) {
      if (revision > (this.zoneData.get(id)?.revision ?? -1)) this.zoneData.set(id, { revision, time: this.manager.now() });
    }
  }

  async poll() {
    await this.connect();
    const now = this.manager.now();
    if (now - this.lastRefresh >= this.manager.refreshMs) {
      await this.api.requestDataHelper(this.system.sysId, REFRESH_PATH);
      this.lastRefresh = now;
    }
    const updated = await this.api.messagePump();
    this.noteData();
    if (updated) this.lastData = this.manager.now();
    if (this.manager.now() - this.lastData > this.manager.staleMs) throw Error('Thermostat readings are stale; reconnecting');
    // A successful empty long-poll is normal and must not reset the controller.
    this.emit();
  }

  start() {
    if (this.running || this.stopped) return;
    this.running = (async () => {
      while (!this.stopped && this.listeners.size) {
        let wait = this.manager.pollMs;
        try { await this.exclusive(() => this.poll()); }
        catch (error) {
          if (this.stopped) break;
          this.readyState = false;
          this.unavailable('Thermostat connection lost. Retrying automatically.');
          this.manager.log('Lennox connection unavailable; retrying');
          await this.api?.close();
          wait = Math.min(this.manager.retryMs * 2 ** this.retryCount++, 60000);
        }
        if (!this.stopped) await this.pause(wait);
      }
    })().finally(() => { this.running = null; });
  }

  pause(ms) {
    return new Promise(resolve => {
      this.wake = () => { clearTimeout(this.timer); this.wake = null; resolve(); };
      this.timer = setTimeout(this.wake, ms);
    });
  }

  async fresh(serial, zoneId) {
    const revisions = () => this.api.periodRevisions || this.api.zoneRevisions;
    const revision = revisions()?.get(zoneId) ?? this.api.revision;
    await this.api.requestDataHelper(this.system.sysId, REFRESH_PATH);
    const until = this.manager.now() + this.manager.confirmTimeoutMs;
    do {
      await this.api.messagePump();
      this.noteData();
      const next = revisions()?.get(zoneId) ?? this.api.revision;
      if (next > revision) {
        this.lastData = this.manager.now();
        return this.zone(serial, zoneId);
      }
      await this.manager.sleep(this.manager.pollMs);
    } while (!this.stopped && this.manager.now() < until);
    throw Error('No fresh thermostat response was received; check its connection');
  }

  async command(serial, zoneId, command) {
    await this.connect();
    let zone = this.zone(serial, zoneId);
    zone = await this.fresh(serial, zoneId);
    if (this.api.hasSetpointMode !== true && zone.setpointModeKnown !== true) throw Error('Thermostat configuration is incomplete. Wait for its setpoint mode before changing settings.');
    const plan = planCommand(this.system, zone, command);
    await this.api.publishMessage(this.system.sysId, plan.data);
    const until = this.manager.now() + this.manager.confirmTimeoutMs;
    do {
      zone = await this.fresh(serial, zoneId);
      const state = normalizeZone(this.system, zone);
      const value = state[plan.expectedKey];
      if (typeof value === 'number' ? Math.abs(value - plan.expectedValue) < 0.26 : value === plan.expectedValue) {
        this.emit(); return state;
      }
      await this.manager.sleep(this.manager.pollMs);
    } while (!this.stopped && this.manager.now() < until);
    this.emit();
    throw Error('The thermostat did not confirm this change. Check its active schedule or away settings before retrying.');
  }

  async close() {
    if (this.stopped) return;
    this.stopped = true; this.wake?.();
    const api = this.api;
    await api?.close();
    await this.queue;
    if (this.api !== api) await this.api?.close();
    this.listeners.clear();
  }
}

class SessionManager {
  constructor(options = {}) {
    this.clientFactory = options.clientFactory || (config => new ManagedS30API(config));
    this.now = options.now || Date.now; this.sleep = options.sleep || delay; this.log = options.log || (() => {});
    this.pollMs = options.pollMs ?? 1000; this.connectTimeoutMs = options.connectTimeoutMs ?? 30000;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 10000; this.retryMs = options.retryMs ?? 5000;
    this.refreshMs = options.refreshMs ?? 30000; this.staleMs = options.staleMs ?? 90000;
    this.sessions = new Map(); this.closed = false;
  }

  get(host) {
    if (this.closed) throw Error('Lennox app is shutting down');
    host = validateHost(host);
    if (!this.sessions.has(host)) this.sessions.set(host, new Session(this, host));
    return this.sessions.get(host);
  }

  async release(session) {
    if (!session.listeners.size && !session.holds) {
      if (this.sessions.get(session.host) === session) this.sessions.delete(session.host);
      await session.close();
    }
  }

  async inspect(host) {
    const session = this.get(host); session.holds++;
    try {
      return await session.exclusive(async () => {
        await session.connect();
        return session.system.zones.filter(zone => !zone.isZoneDisabled && (typeof zone.isZoneActive !== 'function' || zone.isZoneActive()))
          .map(zone => candidate(session.system, zone, session.host));
      });
    } finally { session.holds--; await this.release(session); }
  }

  attach(host, serial, zoneId, onState, onUnavailable) {
    const session = this.get(host);
    const listener = { serial, zoneId, onState, onUnavailable };
    session.listeners.add(listener); session.start();
    let removed = false;
    return async () => {
      if (removed) return;
      removed = true; session.listeners.delete(listener);
      await this.release(session);
    };
  }

  async command(host, serial, zoneId, command, readOnly = true) {
    if (readOnly !== false) throw Error('Read-only mode is enabled. Disable it in this device’s settings to allow changes.');
    const session = this.get(host); session.holds++;
    try { return await session.exclusive(() => session.command(serial, zoneId, command)); }
    finally { session.holds--; await this.release(session); }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => session.close()));
    this.sessions.clear();
  }
}

module.exports = { SessionManager };
