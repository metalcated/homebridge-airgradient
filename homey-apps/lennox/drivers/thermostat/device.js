'use strict';

const Homey = require('homey');
const { validateHost } = require('../../lib/model');

const CAPABILITY_COMMANDS = {
  thermostat_mode: 'mode',
  target_temperature: 'target',
  heat_target: 'heat',
  cool_target: 'cool',
  fan_mode: 'fan',
};
const SUPPORTED_CAPABILITIES = new Set([
  'measure_temperature', 'measure_humidity', 'hvac_state', ...Object.keys(CAPABILITY_COMMANDS),
]);

class LennoxDevice extends Homey.Device {
  async onInit() {
    this._closed = false;
    this._generation = 0;
    this._updates = Promise.resolve();
    this._commandListeners = new Set();
    this._capabilityOptions = new Map();
    for (const capability of Object.keys(CAPABILITY_COMMANDS)) this._registerCommandListener(capability);
    try {
      await this.setUnavailable('Connecting to the thermostat…');
      await this._subscribe(validateHost(this.getSetting('host')));
    } catch (error) {
      await this.setUnavailable(error.message);
      this.error('Thermostat subscription failed:', error.message);
    }
  }

  _identity() {
    const serial = this.getStoreValue('serial');
    const zoneId = this.getStoreValue('zoneId');
    if (serial == null || zoneId == null) throw new Error('Thermostat identity is missing. Repair or pair this device again.');
    return { serial, zoneId };
  }

  _registerCommandListener(capability) {
    const type = CAPABILITY_COMMANDS[capability];
    if (!type || !this.hasCapability(capability) || this._commandListeners.has(capability)) return;
    this.registerCapabilityListener(capability, async (value) => this.writeCommand({ type, value }));
    this._commandListeners.add(capability);
  }

  async _syncCapabilities(candidate, generation) {
    if (!candidate || !Array.isArray(candidate.capabilities)) return;
    const current = () => !this._closed && this._generation === generation;
    const desired = new Set(candidate.capabilities.filter(capability => SUPPORTED_CAPABILITIES.has(capability)));
    for (const capability of desired) {
      if (!current()) return;
      if (!this.hasCapability(capability)) await this.addCapability(capability);
      if (!current()) return;
      this._registerCommandListener(capability);
    }

    // Partial responses and sensor errors must not remove existing readings or
    // their history. Only a positively identified alternative setpoint mode
    // replaces controls that are mutually exclusive with that mode.
    const obsolete = desired.has('target_temperature') ? ['heat_target', 'cool_target']
      : desired.has('heat_target') || desired.has('cool_target') ? ['target_temperature'] : [];
    for (const capability of obsolete) {
      if (!current()) return;
      if (this.hasCapability(capability)) await this.removeCapability(capability);
      this._commandListeners.delete(capability);
      this._capabilityOptions.delete(capability);
    }
    for (const [capability, options] of Object.entries(candidate.capabilitiesOptions || {})) {
      if (!current()) return;
      if (!desired.has(capability) || !this.hasCapability(capability)) continue;
      const serialized = JSON.stringify(options);
      if (this._capabilityOptions.get(capability) === serialized) continue;
      await this.setCapabilityOptions(capability, options);
      this._capabilityOptions.set(capability, serialized);
    }
  }

  async _subscribe(host) {
    if (this._closed) throw new Error('Thermostat is stopping. Try again shortly.');
    const { serial, zoneId } = this._identity();
    const generation = this._generation + 1;
    const enqueue = (operation) => {
      this._updates = this._updates.then(async () => {
        if (this._closed || this._generation !== generation) return;
        await operation();
      }).catch((error) => this.error('Could not update thermostat in Homey:', error.message));
    };
    const unsubscribe = this.homey.app.sessions.attach(host, serial, zoneId, (state, candidate) => {
      enqueue(async () => {
        await this._syncCapabilities(candidate, generation);
        for (const [capability, value] of Object.entries(state)) {
          if (this._closed || this._generation !== generation) return;
          if (this.hasCapability(capability) && value !== undefined) {
            await this.setCapabilityValue(capability, value);
          }
        }
        if (!this._closed && this._generation === generation) await this.setAvailable();
      });
    }, (message) => {
      enqueue(async () => this.setUnavailable(message || 'Cannot reach the thermostat. Retrying automatically.'));
    });
    if (typeof unsubscribe !== 'function') throw new Error('Thermostat session could not be created.');
    const previous = this._unsubscribe;
    this._generation = generation;
    this._host = host;
    this._unsubscribe = unsubscribe;
    if (previous) {
      try { await previous(); }
      catch (error) { this.error('Could not close the previous thermostat session:', error.message); }
    }
  }

  async writeCommand(command) {
    if (this._closed) throw new Error('Thermostat is stopping. Try again shortly.');
    const { serial, zoneId } = this._identity();
    await this.homey.app.sessions.command(
      this._host || validateHost(this.getSetting('host')),
      serial,
      zoneId,
      command,
      this.getSetting('read_only') !== false,
    );
  }

  async _validateReplacement(host) {
    if (this._closed) throw new Error('Thermostat is stopping. Try again shortly.');
    const candidates = await this.homey.app.sessions.inspect(host);
    if (this._closed) throw new Error('Thermostat is stopping. Try again shortly.');
    const candidate = candidates.find((item) => item.data && item.data.id === this.getData().id);
    if (!candidate) throw new Error('This address belongs to a different thermostat or does not contain this zone.');
    return candidate;
  }

  async onSettings({ newSettings, changedKeys }) {
    if (typeof newSettings.read_only !== 'boolean') throw new Error('Read-only mode must be enabled or disabled.');
    const host = validateHost(newSettings.host);
    if (changedKeys.includes('host') && host !== this._host) {
      await this._validateReplacement(host);
      await this._subscribe(host);
    }
  }

  async reconnectHost(host) {
    const address = validateHost(host);
    await this._validateReplacement(address);
    // Persist first; on failure, the existing live connection remains in use.
    const oldHost = this.getSetting('host');
    await this.setSettings({ host: address });
    try {
      await this._subscribe(address);
    } catch (error) {
      await this.setSettings({ host: oldHost });
      throw error;
    }
  }

  async onUninit() {
    this._closed = true;
    this._generation += 1;
    if (this._unsubscribe) {
      await this._unsubscribe();
      this._unsubscribe = undefined;
    }
    await this._updates;
  }

  async onDeleted() {
    await this.onUninit();
  }
}

module.exports = LennoxDevice;
