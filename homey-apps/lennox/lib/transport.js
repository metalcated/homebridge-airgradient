'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomBytes } = require('node:crypto');
const { S30API } = require('lennoxapi');
const { validateHost, validateDeadbandParameter } = require('./model');
const { IdentityTracker } = require('./identity');

// Adapt the pinned parser/client rather than changing the global TLS or HTTP
// configuration. Some Lennox LAN firmware sends conflicting framing headers.
class ManagedS30API extends S30API {
  constructor({ host, port, protocol = 'https', requestTimeoutMs = 10000 }) {
    host = validateHost(host);
    if (!['http', 'https'].includes(protocol)) throw Error('Unsupported transport');
    port ??= protocol === 'https' ? 443 : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 1) throw Error('Invalid request timeout');
    const address = host.includes(':') ? `[${host}]` : host;
    super({ ipAddress: `${address}:${port}`, protocol, longPollDelay: 2,
      appId: `homey${randomBytes(10).toString('hex')}` });
    this.origin = `${protocol}://${address}:${port}`;
    this.requestTimeoutMs = requestTimeoutMs;
    this.requests = new Set();
    this.closed = false;
    this.lastMessageAt = 0;
    this.lastResponseAt = 0;
    this.revision = 0;
    this.zoneRevisions = new Map();
    this.temperatureRevisions = new Map();
    this.periodRevisions = new Map();
    // Diagnostic snapshots retain which representations actually arrived
    // together, separately from the upstream parser's merged attribute cache.
    this.periodReportRevision = 0;
    this.targetReports = new Map();
    this.lastPublishAcknowledgement = null;
    // Track whether parameter 525 was actually reported. The upstream default
    // false alone cannot tell us which temperature mode the thermostat uses.
    this.hasSetpointMode = false;
    this.hasTemperatureDeadband = false;
    this.temperatureDeadbandRevision = 0;
    this.temperatureDeadband = null;
    this.deadbandEquipmentTypes = new Map();
    this.deadbandParameters = new Map();
    this.identity = new IdentityTracker();
  }

  request(method, url, body) {
    if (this.closed) return Promise.reject(Error('Connection closed'));
    const target = new URL(url);
    if (target.origin !== new URL(this.origin).origin) return Promise.reject(Error('Unexpected thermostat endpoint'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.requests.delete(req);
        error ? reject(error) : resolve(result);
      };
      const req = (target.protocol === 'https:' ? https : http).request(target, {
        method, agent: false,
        // Scoped to this one LAN thermostat, whose certificate is self-signed.
        rejectUnauthorized: false, insecureHTTPParser: true,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
      }, response => {
        const chunks = []; let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) req.destroy(Error('Thermostat response is too large'));
          else chunks.push(chunk);
        });
        response.on('error', error => finish(error));
        response.on('aborted', () => finish(Error('Thermostat response interrupted')));
        response.on('end', () => {
          this.lastResponseAt = Date.now();
          const text = Buffer.concat(chunks).toString('utf8');
          finish(null, { status: response.statusCode, text: async () => text });
        });
      });
      const timer = setTimeout(() => req.destroy(Error('Thermostat request timed out')), this.requestTimeoutMs);
      this.requests.add(req);
      req.on('error', error => finish(error));
      req.end(body);
    });
  }

  get(url) { return this.request('GET', url); }
  async post(url, body) {
    const publication = url === this.urlPublish;
    if (publication) this.lastPublishAcknowledgement = null;
    const response = await this.request('POST', url, body);
    if (publication) {
      let code = null;
      try {
        // request() has already bounded and cached the response body. Retain
        // only numeric ACK metadata; the pinned publisher's policy is unchanged.
        const value = JSON.parse(await response.text())?.code;
        if (typeof value === 'number' && Number.isFinite(value)) code = value;
      } catch { /* empty or malformed legacy responses have no numeric code */ }
      this.lastPublishAcknowledgement = { status: response.status, code };
    }
    return response;
  }

  async publishTemperatureDeadband(sysId, value) {
    const parameter = this.temperatureDeadband;
    if (!this.hasTemperatureDeadband) throw Error('The thermostat has not reported an editable automatic changeover gap');
    validateDeadbandParameter(value, parameter);
    const message = { MessageType: 'Command', SenderID: this.applicationId, MessageID: this.getNextMessageId(),
      TargetID: sysId, AdditionalParameters: '/systemControl',
      Data: { systemControl: { parameterUpdate: { et: parameter.equipmentType, pid: 104, value: String(value) } } } };
    const response = await this.post(this.urlPublish, JSON.stringify(message));
    if (response.status !== 200) throw Error('The thermostat rejected the automatic changeover gap update');
    let acknowledgement;
    try { acknowledgement = JSON.parse(await response.text()); }
    catch { throw Error('The thermostat returned an invalid automatic changeover gap acknowledgement'); }
    if (acknowledgement?.code !== 1) throw Error('The thermostat did not acknowledge the automatic changeover gap update');
  }

  processMessage(message) {
    if (!message || !message.Data || typeof message.Data !== 'object') return;
    const system = this.getSystem('LCC');
    if (!system) return;
    const data = message.Data;
    // A LAN sender can identify itself by serial number rather than LCC. Keep
    // every update on the initialized local system (fixed upstream after 0.1.2).
    for (const equipment of data.equipments || []) {
      if (equipment.equipment && 'equipType' in equipment.equipment) {
        const type = equipment.equipment.equipType;
        this.deadbandEquipmentTypes.set(equipment.id, Number.isInteger(type) && type >= 0 ? type : undefined);
      }
      for (const item of equipment.equipment?.parameters || []) {
        const parameter = item.parameter;
        if (Number(parameter?.pid) === 104) {
          const cached = this.deadbandParameters.get(equipment.id) || {};
          if ('value' in parameter) {
            const valid = [3, 4, 5, 6, 7, 8, 9, '3', '4', '5', '6', '7', '8', '9'].includes(parameter.value);
            cached.valueF = valid ? Number(parameter.value) : null;
            this.temperatureDeadbandRevision++;
          }
          if ('enabled' in parameter) cached.enabled = parameter.enabled === true;
          for (const key of ['descriptor', 'unit']) if (key in parameter) cached[key] = parameter[key];
          if ('range' in parameter) {
            if (parameter.range && typeof parameter.range === 'object' && !Array.isArray(parameter.range)) {
              cached.range = { ...cached.range };
              for (const key of ['min', 'max', 'inc']) if (key in parameter.range) cached.range[key] = parameter.range[key];
            } else cached.range = null;
          }
          this.deadbandParameters.set(equipment.id, cached);
        }
        if (Number(parameter?.pid) !== 525) continue;
        if (![0, 1, '0', '1'].includes(parameter.value)) {
          this.hasSetpointMode = false;
          // Do not let a malformed later value reset the parser's last known mode.
          parameter.pid = -1;
          continue;
        }
        parameter.pid = 525; parameter.value = String(parameter.value);
        this.hasSetpointMode = true;
      }
    }
    system.processMessage(data);
    if (this.deadbandParameters.size) {
      const entries = [...this.deadbandParameters.entries()];
      const [id, parameter] = entries.length === 1 ? entries[0] : [];
      this.temperatureDeadband = parameter ? { ...parameter, equipmentType: this.deadbandEquipmentTypes.get(id) } : null;
      this.hasTemperatureDeadband = Number.isInteger(this.temperatureDeadband?.valueF);
      // Preserve the distinction between defaults and the controller's actual
      // parameter. Multiple possible parameter owners are unsafe to edit.
      system.hasTemperatureDeadband = this.hasTemperatureDeadband;
      system.hspCspSeparation = this.hasTemperatureDeadband ? this.temperatureDeadband.valueF : null;
      system.hspCCspCSeparation = this.hasTemperatureDeadband ? Math.round(this.temperatureDeadband.valueF * 5 / 9 * 2) / 2 : null;
    }
    const identity = this.identity.update(data);
    system.serialNumber = identity.serial;
    if (identity.productType) system.productType = identity.productType;
    for (const zone of data.zones || []) {
      if (zone.status) this.zoneRevisions.set(zone.id, (this.zoneRevisions.get(zone.id) || 0) + 1);
      if (zone.status && ('temperature' in zone.status || 'temperatureC' in zone.status)) {
        this.temperatureRevisions.set(zone.id, (this.temperatureRevisions.get(zone.id) || 0) + 1);
      }
      const period = zone.status?.period;
      if (period && typeof period === 'object') {
        const revision = ++this.periodReportRevision;
        const reports = { ...this.targetReports.get(zone.id) };
        for (const [kind, key] of [['heat', 'hsp'], ['cool', 'csp'], ['target', 'sp']]) {
          const hasF = key in period, hasC = key + 'C' in period;
          if (!hasF && !hasC) continue;
          const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
          reports[kind] = { revision, hasF, hasC,
            fahrenheit: numeric(period[key]), celsius: numeric(period[key + 'C']) };
        }
        this.targetReports.set(zone.id, reports);
      }
      if (period && 'systemMode' in period && 'fanMode' in period &&
        (('hsp' in period || 'hspC' in period) && ('csp' in period || 'cspC' in period) || 'sp' in period || 'spC' in period)) {
        this.periodRevisions.set(zone.id, (this.periodRevisions.get(zone.id) || 0) + 1);
      }
      const parsed = system.zones.find(item => item.id === zone.id);
      if (parsed && period && typeof period === 'object') {
        for (const key of ['hsp', 'csp', 'sp']) {
          const hasF = key in period, hasC = key + 'C' in period;
          // A single-unit update supersedes the previous target. The pinned
          // parser retains omitted attributes, so discard its stale counterpart
          // and let consumers convert the value that actually arrived.
          if (hasF !== hasC) parsed[hasF ? key + 'C' : key] = undefined;
        }
      }
      if (parsed && zone.config) {
        if ('temperatureDeadbandC' in zone.config) parsed.temperatureDeadbandC = zone.config.temperatureDeadbandC;
        if ('writeAccess' in zone.config) parsed.localWriteAccess = zone.config.writeAccess;
        if (zone.config.singleSetpointAvailable === false) parsed.setpointModeKnown = true;
      }
    }
    this.lastMessageAt = Date.now();
    this.revision++;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.requests) request.destroy(Error('Connection closed'));
    this.requests.clear();
    // The pinned client's dispatcher is otherwise never disposed by shutdown().
    await this.dispatcher.destroy();
  }
}

module.exports = { ManagedS30API };
