'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomBytes } = require('node:crypto');
const { S30API } = require('lennoxapi');
const { validateHost } = require('./model');

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
    // Track whether parameter 525 was actually reported. The upstream default
    // false alone cannot tell us which temperature mode the thermostat uses.
    this.hasSetpointMode = false;
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
  post(url, body) { return this.request('POST', url, body); }

  processMessage(message) {
    if (!message || !message.Data || typeof message.Data !== 'object') return;
    const system = this.getSystem('LCC');
    if (!system) return;
    const data = message.Data;
    // A LAN sender can identify itself by serial number rather than LCC. Keep
    // every update on the initialized local system (fixed upstream after 0.1.2).
    for (const equipment of data.equipments || []) {
      for (const item of equipment.equipment?.parameters || []) {
        const parameter = item.parameter;
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
    for (const zone of data.zones || []) {
      if (zone.status) this.zoneRevisions.set(zone.id, (this.zoneRevisions.get(zone.id) || 0) + 1);
      if (zone.status && ('temperature' in zone.status || 'temperatureC' in zone.status)) {
        this.temperatureRevisions.set(zone.id, (this.temperatureRevisions.get(zone.id) || 0) + 1);
      }
      const period = zone.status?.period;
      if (period && 'systemMode' in period && 'fanMode' in period &&
        (('hsp' in period || 'hspC' in period) && ('csp' in period || 'cspC' in period) || 'sp' in period || 'spC' in period)) {
        this.periodRevisions.set(zone.id, (this.periodRevisions.get(zone.id) || 0) + 1);
      }
      const parsed = system.zones.find(item => item.id === zone.id);
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
