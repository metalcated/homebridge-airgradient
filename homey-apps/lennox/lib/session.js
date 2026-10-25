'use strict';

const { ManagedS30API } = require('./transport');
const { validateHost, normalizeZone, candidate, planCommand, planDeadband, deadbandLimits, resolveAdjustment } = require('./model');
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

  async connect(context) {
    this.manager.checkCommand(context);
    if (this.readyState) return;
    await this.api?.close();
    this.manager.checkCommand(context);
    if (this.stopped) throw Error('Connection closed');
    this.zoneData.clear();
    this.api = this.manager.clientFactory({ host: this.host });
    const api = this.api;
    await api.serverConnect();
    this.manager.checkCommand(context);
    this.system = api.getSystem('LCC');
    if (!this.system) throw Error('Thermostat did not provide a local system');
    await api.subscribe(this.system);
    this.manager.checkCommand(context);
    const until = this.manager.now() + this.manager.connectTimeoutMs;
    let catalog, catalogChangedAt = this.manager.now(), messages = 0, idle = 0;
    while (!this.stopped && this.manager.now() < until) {
      const updated = await api.messagePump();
      this.manager.checkCommand(context);
      if (updated) messages++; else idle++;
      this.noteData();
      const system = this.system;
      // Real controllers may continuously report unrelated system updates.
      // Settle the discovery catalog, not the entire message stream. Numeric
      // readings changing must not postpone pairing indefinitely.
      const active = system.zones.filter(zone => !zone.isZoneDisabled && zone.name != null);
      const usable = typeof system.serialNumber === 'string' && system.serialNumber.trim() &&
        active.some(zone => normalizeZone(system, zone).measure_temperature !== undefined);
      const nextCatalog = JSON.stringify({ serial: system.serialNumber, model: system.productType,
        zones: system.zones.map(zone => ({ id: zone.id, disabled: zone.isZoneDisabled, name: zone.name,
          hasTemperature: normalizeZone(system, zone).measure_temperature !== undefined,
          heat: zone.heatingOption, cool: zone.coolingOption,
          minHeat: zone.minHspC, maxHeat: zone.maxHspC, minCool: zone.minCspC, maxCool: zone.maxCspC })),
        single: system.singleSetpointMode, separationF: system.hspCspSeparation,
        separationC: system.hspCCspCSeparation, separationReported: api.hasTemperatureDeadband === true });
      if (catalog !== nextCatalog) { catalog = nextCatalog; catalogChangedAt = this.manager.now(); }
      if (usable && this.manager.now() - catalogChangedAt >= this.manager.catalogSettleMs) {
        this.readyState = true; this.lastData = this.manager.now(); this.lastRefresh = this.lastData;
        this.retryCount = 0;
        let separationEditable = false, separationRange;
        try { separationRange = deadbandLimits(api.temperatureDeadband); separationEditable = true; }
        catch { /* a reported value alone does not authorize parameter writes */ }
        this.manager.log('Lennox temperature policy', { mode: active[0]?.systemMode ?? null,
          singleSetpoint: system.singleSetpointMode, separationF: system.hspCspSeparation ?? null,
          separationC: system.hspCCspCSeparation ?? null, separationReported: api.hasTemperatureDeadband === true,
          separationEditable, ...(separationRange ? { separationMinF: separationRange.min, separationMaxF: separationRange.max } : {}) });
        this.emit();
        return;
      }
      // Startup can queue dozens of separate configuration messages. Draining
      // at the normal steady-state poll interval can consume the entire pairing
      // deadline before the zones arrive. Yield briefly while data is queued.
      await this.manager.commandSleep(updated ? this.manager.drainMs : this.manager.pollMs, context);
    }
    const identified = typeof this.system.serialNumber === 'string' && !!this.system.serialNumber.trim();
    const zones = this.system.zones.filter(zone => !zone.isZoneDisabled && zone.name != null);
    const hasTemperature = zones.some(zone => normalizeZone(this.system, zone).measure_temperature !== undefined);
    const missing = [!identified && 'controller identity', !hasTemperature && 'active-zone temperature'].filter(Boolean);
    this.manager.log('Lennox pairing response summary', { messages, idle, identified,
      activeZones: zones.length, hasTemperature });
    throw Error(`Connected to the thermostat, but ${missing.length ? `its ${missing.join(' and ')} did not arrive` : 'its zone catalog did not settle'} in time. Check that another local integration is not connected, then retry.`);
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

  async fresh(serial, zoneId, context) {
    this.manager.checkCommand(context);
    const revisions = () => this.api.periodRevisions || this.api.zoneRevisions;
    const revision = revisions()?.get(zoneId) ?? this.api.revision;
    await this.api.requestDataHelper(this.system.sysId, REFRESH_PATH);
    this.manager.checkCommand(context);
    const until = this.manager.now() + this.manager.confirmTimeoutMs;
    do {
      const updated = await this.api.messagePump();
      this.manager.checkCommand(context);
      this.noteData();
      const next = revisions()?.get(zoneId) ?? this.api.revision;
      if (next > revision) {
        this.lastData = this.manager.now();
        return this.zone(serial, zoneId);
      }
      await this.manager.commandSleep(updated ? this.manager.drainMs : this.manager.pollMs, context);
    } while (!this.stopped && this.manager.now() < until);
    throw Error('No fresh thermostat response was received; check its connection');
  }

  temperatureReadback(plan, zone, zoneId, outcome) {
    if (!plan.temperature) return;
    for (const { key, celsius, fahrenheit, units } of plan.temperatures || [plan.temperature]) {
      const target = { hsp: 'heat', csp: 'cool', sp: 'target' }[key];
      const report = this.api.targetReports?.get(zoneId)?.[target];
      const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
      // A bounded local diagnostic, with no address, serial, zone name or payload.
      // Presence flags distinguish a current wire value from the parser's cache.
      this.manager.log('Lennox temperature readback', { outcome, target, units,
        expectedC: celsius, expectedF: fahrenheit,
        parsedC: number(zone[key + 'C']), parsedF: number(zone[key]),
        targetReportRevision: report?.revision ?? null,
        reportedCPresent: report?.hasC ?? null, reportedFPresent: report?.hasF ?? null,
        reportedC: number(report?.celsius), reportedF: number(report?.fahrenheit),
        publishStatus: number(this.api.lastPublishAcknowledgement?.status),
        publishCode: number(this.api.lastPublishAcknowledgement?.code) });
    }
  }

  async command(serial, zoneId, command, context) {
    await this.manager.commandPhase(context, 'connect', () => this.connect(context));
    let zone = this.zone(serial, zoneId);
    if (command?.type === 'deadband') return this.changeDeadband(serial, zoneId, command.value, context);
    zone = await this.manager.commandPhase(context, 'refresh', () => this.fresh(serial, zoneId, context));
    if (this.api.hasSetpointMode !== true && zone.setpointModeKnown !== true) throw Error('Thermostat configuration is incomplete. Wait for its setpoint mode before changing settings.');
    const resolved = command?.type === 'adjust' ? resolveAdjustment(this.system, zone, command) : command;
    const plan = planCommand(this.system, zone, resolved);
    await this.manager.commandPhase(context, 'publish', () => this.api.publishMessage(this.system.sysId, plan.data));
    return this.manager.commandPhase(context, 'confirm', async () => {
      const until = this.manager.now() + this.manager.confirmTimeoutMs;
      do {
        zone = await this.fresh(serial, zoneId, context);
        const state = normalizeZone(this.system, zone);
        const value = state[plan.expectedKey];
        let confirmed = value === plan.expectedValue;
        if (plan.temperature) {
          confirmed = (plan.temperatures || [plan.temperature]).every(temperature => {
            const actualC = zone[temperature.key + 'C'], actualF = zone[temperature.key];
            const hasC = typeof actualC === 'number' && Number.isFinite(actualC);
            const hasF = typeof actualF === 'number' && Number.isFinite(actualF);
            if (temperature.units === 'imperial') {
              // Fahrenheit-configured firmware can echo an exact conversion rather
              // than the half-degree Celsius representation that we published.
              return (hasC || hasF) && (!hasF || actualF === temperature.fahrenheit) &&
                (!hasC || Math.round(actualC * 9 / 5 + 32) === temperature.fahrenheit);
            }
            // Metric requests must still match the requested half-degree grid;
            // accepting the neighbouring Celsius step would misreport success.
            return (hasC ? Math.round(actualC * 2) / 2 === temperature.celsius : hasF) &&
              (!hasF || Math.round(actualF) === temperature.fahrenheit);
          });
        }
        if (confirmed) {
          this.temperatureReadback(plan, zone, zoneId, 'confirmed');
          this.emit(); return state;
        }
        await this.manager.commandSleep(this.manager.drainMs, context);
      } while (!this.stopped && this.manager.now() < until);
      this.temperatureReadback(plan, zone, zoneId, 'unconfirmed');
      this.emit();
      throw Error('The thermostat did not confirm this change. Its latest reported state did not match the request; check the current reading before retrying.');
    });
  }

  async freshDeadband(serial, zoneId, allZones, context) {
    this.manager.checkCommand(context);
    if (typeof this.api.temperatureDeadbandRevision !== 'number' || !this.api.periodRevisions) throw Error('This thermostat connection cannot confirm automatic changeover gap changes');
    const parameterRevision = this.api.temperatureDeadbandRevision;
    const revisions = new Map(this.api.periodRevisions);
    await this.api.requestDataHelper(this.system.sysId, REFRESH_PATH);
    this.manager.checkCommand(context);
    const until = this.manager.now() + this.manager.confirmTimeoutMs;
    do {
      const updated = await this.api.messagePump();
      this.manager.checkCommand(context);
      this.noteData();
      this.zone(serial, zoneId);
      const active = this.system.zones.filter(item => !item.isZoneDisabled && (typeof item.isZoneActive !== 'function' || item.isZoneActive()));
      const freshZones = !allZones || active.every(item => (this.api.periodRevisions.get(item.id) ?? 0) > (revisions.get(item.id) ?? 0));
      if (this.api.temperatureDeadbandRevision > parameterRevision && freshZones) {
        this.lastData = this.manager.now();
        return this.api.temperatureDeadband;
      }
      await this.manager.commandSleep(updated ? this.manager.drainMs : this.manager.pollMs, context);
    } while (!this.stopped && this.manager.now() < until);
    throw Error('No fresh automatic changeover gap and active-zone configuration was received; nothing was confirmed');
  }

  async changeDeadband(serial, zoneId, value, context) {
    await this.manager.commandPhase(context, 'refresh', () => this.freshDeadband(serial, zoneId, true, context));
    const zone = this.zone(serial, zoneId);
    if (this.api.hasSetpointMode !== true && zone.setpointModeKnown !== true) throw Error('Thermostat configuration is incomplete. Wait for its setpoint mode before changing settings.');
    const plan = planDeadband(this.system, value, this.api.temperatureDeadband);
    await this.manager.commandPhase(context, 'publish', () => this.api.publishTemperatureDeadband(this.system.sysId, plan.valueF));
    return this.manager.commandPhase(context, 'confirm', async () => {
      const until = this.manager.now() + this.manager.confirmTimeoutMs;
      do {
        const parameter = await this.freshDeadband(serial, zoneId, false, context);
        if (this.api.hasTemperatureDeadband === true && parameter?.valueF === plan.valueF) {
          this.emit(); return normalizeZone(this.system, this.zone(serial, zoneId));
        }
        await this.manager.commandSleep(this.manager.drainMs, context);
      } while (!this.stopped && this.manager.now() < until);
      this.emit();
      throw Error('The thermostat did not confirm the controller-wide automatic changeover gap change');
    });
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
    this.drainMs = options.drainMs ?? Math.min(25, this.pollMs);
    this.catalogSettleMs = options.catalogSettleMs ?? Math.min(1000, this.connectTimeoutMs / 3);
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 10000; this.retryMs = options.retryMs ?? 5000;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 40000;
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

  commandTimeout(context) {
    const error = Error('The thermostat command timed out. Its final state could not be confirmed; check the current reading before retrying.');
    error.code = 'LENNOX_COMMAND_TIMEOUT';
    return error;
  }

  checkCommand(context) {
    if (context && (context.expired || this.now() >= context.deadline)) {
      context.expired = true;
      throw this.commandTimeout(context);
    }
  }

  async commandSleep(ms, context) {
    this.checkCommand(context);
    await this.sleep(context ? Math.min(ms, Math.max(0, context.deadline - this.now())) : ms);
    this.checkCommand(context);
  }

  async commandPhase(context, phase, work) {
    this.checkCommand(context);
    const started = this.now();
    if (context) { context.phase = phase; context.phaseStarted = started; }
    try {
      const result = await work();
      this.checkCommand(context);
      return result;
    } finally {
      if (context) {
        context.timings[phase] = (context.timings[phase] ?? 0) + this.now() - started;
        context.phaseStarted = undefined;
      }
    }
  }

  logCommand(context, outcome) {
    if (context.logged) return;
    context.logged = true;
    // Only fixed operation/phase names and elapsed times; never device IDs,
    // addresses, requested temperatures, or protocol data.
    const timings = { ...context.timings };
    if (context.phase === 'queued') timings.queue = this.now() - context.started;
    if (context.phase !== 'queued' && context.phaseStarted !== undefined) {
      timings[context.phase] = (timings[context.phase] ?? 0) + this.now() - context.phaseStarted;
    }
    this.log('Lennox command timing', { operation: context.operation, outcome,
      phase: context.phase, elapsedMs: this.now() - context.started,
      ...Object.fromEntries(Object.entries(timings).map(([phase, ms]) => [phase + 'Ms', ms])) });
  }

  async command(host, serial, zoneId, command, readOnly = true) {
    if (readOnly !== false) throw Error('Read-only mode is enabled. Disable it in this device’s settings to allow changes.');
    const started = this.now();
    const context = { started, deadline: started + this.commandTimeoutMs, phase: 'queued', timings: {},
      operation: ['mode', 'fan', 'heat', 'cool', 'target', 'adjust', 'deadband'].includes(command?.type) ? command.type : 'unsupported' };
    const session = this.get(host); session.holds++;
    // A caller deadline must not release the serialized queue while a request
    // is in flight. The transport bounds individual requests; this context
    // prevents any later phase (especially publication) after expiry.
    const work = session.exclusive(() => {
      context.timings.queue = this.now() - started;
      this.checkCommand(context);
      return session.command(serial, zoneId, command, context);
    }).finally(async () => { session.holds--; await this.release(session); });
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        context.expired = true;
        this.logCommand(context, 'timeout');
        reject(this.commandTimeout(context));
      }, Math.max(0, context.deadline - this.now()));
      work.then(resolve, reject);
    });
    try {
      const state = await deadline;
      this.logCommand(context, 'confirmed');
      return state;
    } catch (error) {
      this.logCommand(context, context.expired ? 'timeout' : 'failed');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map(session => session.close()));
    this.sessions.clear();
  }
}

module.exports = { SessionManager };
