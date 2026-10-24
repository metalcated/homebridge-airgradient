'use strict';
const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DeviceClient } = require('../dist/device');
const { validateSensors } = require('../dist/config');
const { SensorStore } = require('../dist/storage');
const { discover } = require('../dist/discovery');

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const handle = fn => async payload => {
      try { return await fn(payload); }
      catch (error) { throw new RequestError(error.message); }
    };
    this.onRequest('/discover', handle(() => discover()));
    this.onRequest('/probe', handle(async payload => {
      const [config] = validateSensors([payload]);
      const client = new DeviceClient(config);
      try {
        const data = await client.measures();
        return { serialno: config.serialno, model: data.model, firmware: data.firmware, apiVersion: client.version,
          measurements: Object.keys(data).filter(key => typeof data[key] === 'number') };
      } finally { client.stop(); }
    }));
    this.onRequest('/diagnostics', handle(payload => this.stored(payload, (store, serial) => {
      const data = store.readDiagnostics(serial);
      return data ? { ...data, ageSeconds: data.lastSuccess ? Math.floor((Date.now() - data.lastSuccess) / 1000) : null } : null;
    })));
    this.onRequest('/history', handle(payload => this.stored(payload, (store, serial) => store.history(serial, 240))));
    this.ready();
  }

  stored(payload, read) {
    const config = JSON.parse(readFileSync(this.homebridgeConfigPath || join(this.homebridgeStoragePath, 'config.json'), 'utf8'));
    const aliases = ['AirGradientPlatform', 'homebridge-airgradient.AirGradientPlatform', '@metalcated/homebridge-airgradient.AirGradientPlatform'];
    const allowed = (config.platforms || []).filter(item => aliases.includes(item.platform))
      .flatMap(item => validateSensors(item.sensors));
    const serial = String(payload?.serialno || '');
    if (!allowed.some(item => item.serialno === serial)) {
      throw new Error('This sensor is not in the saved Homebridge configuration. Save and restart first.');
    }
    const store = new SensorStore(this.homebridgeStoragePath);
    try { return read(store, serial); }
    finally { store.close(); }
  }
}
module.exports = { UiServer };
if (require.main === module) { new UiServer(); }
