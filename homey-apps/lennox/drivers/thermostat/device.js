'use strict';

const Homey = require('homey');
const { validateHost } = require('../../lib/model');

const CAPABILITY_COMMANDS = {
  thermostat_mode: 'mode',
  target_temperature: 'target',
  'target_temperature.heat': 'heat',
  'target_temperature.cool': 'cool',
  heat_target: 'heat',
  cool_target: 'cool',
  fan_mode: 'fan',
};
const DIRECTION_MODES = new Set(['thermostat_mode.heat', 'thermostat_mode.cool']);
const NATIVE_TARGETS = new Set(['target_temperature.heat', 'target_temperature.cool']);
const ADJUSTMENTS = {
  heat_decrease: { target: 'heat', direction: -1 },
  heat_increase: { target: 'heat', direction: 1 },
  cool_decrease: { target: 'cool', direction: -1 },
  cool_increase: { target: 'cool', direction: 1 },
  target_decrease: { target: 'target', direction: -1 },
  target_increase: { target: 'target', direction: 1 },
};
const SUPPORTED_CAPABILITIES = new Set([
  'measure_temperature', 'measure_humidity', 'hvac_state', 'measure_temperature.heat', 'measure_temperature.cool',
  ...DIRECTION_MODES, ...Object.keys(CAPABILITY_COMMANDS), ...Object.keys(ADJUSTMENTS),
]);

class LennoxDevice extends Homey.Device {
  async onInit() {
    this._closed = false;
    this._generation = 0;
    this._updates = Promise.resolve();
    this._commandListeners = new Set();
    this._capabilityOptions = new Map();
    for (const capability of [...Object.keys(CAPABILITY_COMMANDS), ...DIRECTION_MODES, ...Object.keys(ADJUSTMENTS)]) this._registerCommandListener(capability);
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

  _temperatureUnits() {
    const units = this.getSetting('temperature_control_units') ?? 'imperial';
    if (!['metric', 'imperial'].includes(units)) {
      throw new Error('Select Fahrenheit or Celsius for temperature controls in device settings.');
    }
    return units;
  }

  _registerCommandListener(capability) {
    const type = CAPABILITY_COMMANDS[capability];
    const adjustment = ADJUSTMENTS[capability];
    if ((!type && !adjustment && !DIRECTION_MODES.has(capability)) || !this.hasCapability(capability) || this._commandListeners.has(capability)) return;
    this.registerCapabilityListener(capability, async (value) => {
      if (DIRECTION_MODES.has(capability)) throw new Error('Use the main thermostat mode control.');
      if (adjustment) {
        if (value !== true) throw new Error('Press the temperature adjustment button to change its target.');
        const units = this._temperatureUnits();
        return this.writeCommand({ type: 'adjust', ...adjustment, units });
      }
      const command = { type, value };
      if (capability === 'target_temperature' || NATIVE_TARGETS.has(capability)) {
        command.units = this._temperatureUnits();
      }
      return this.writeCommand(command);
    });
    this._commandListeners.add(capability);
  }

  async _syncCapabilities(candidate, generation) {
    if (!candidate || !Array.isArray(candidate.capabilities)) return;
    const current = () => !this._closed && this._generation === generation;
    const units = this._temperatureUnits();
    const desired = new Set(candidate.capabilities.filter(capability => SUPPORTED_CAPABILITIES.has(capability)));
    const nativeTargets = Array.isArray(candidate.nativeTargets)
      ? new Set(candidate.nativeTargets.filter(capability => NATIVE_TARGETS.has(capability))) : null;
    const adjustments = Array.isArray(candidate.adjustments)
      ? new Set(candidate.adjustments.filter(capability => Object.hasOwn(ADJUSTMENTS, capability))) : null;
    if (nativeTargets) {
      for (const capability of NATIVE_TARGETS) {
        if (nativeTargets.has(capability)) continue;
        desired.delete(capability);
        if (!current()) return;
        if (this.hasCapability(capability)) await this.removeCapability(capability);
        this._commandListeners.delete(capability);
        this._capabilityOptions.delete(capability);
      }
    }
    if (adjustments) {
      for (const capability of adjustments) desired.add(capability);
    }
    for (const capability of desired) {
      if (!current()) return;
      if (!this.hasCapability(capability)) await this.addCapability(capability);
      if (!current()) return;
      this._registerCommandListener(capability);
    }

    // Preserve legacy targets, measurements, history and Flow references. Only
    // derived native target aliases follow an authoritative mode-specific list.
    const optionsByCapability = { ...(candidate.capabilitiesOptions || {}) };
    if (adjustments) {
      for (const capability of Object.keys(ADJUSTMENTS)) {
        optionsByCapability[capability] = {
          ...(optionsByCapability[capability] || {}),
          uiComponent: adjustments.has(capability) ? 'button' : null,
          preventInsights: true,
          preventTag: true,
        };
      }
    }
    for (const [capability, declaredOptions] of Object.entries(optionsByCapability)) {
      if (!current()) return;
      if (!SUPPORTED_CAPABILITIES.has(capability) || !this.hasCapability(capability)) continue;
      const options = (capability === 'target_temperature' || NATIVE_TARGETS.has(capability)) &&
        Number.isFinite(declaredOptions.min) && Number.isFinite(declaredOptions.max)
        // Homey converts temperature bounds and values to Fahrenheit for the UI,
        // but passes the step through unchanged. Keep its displayed increment sane.
        ? { ...declaredOptions, step: units === 'imperial' ? 1 : 0.5 } : declaredOptions;
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
        const gap = candidate?.changeoverGap;
        if (!this._closed && this._generation === generation &&
          Number.isInteger(gap) && gap >= 3 && gap <= 9 && this.getSetting('auto_changeover_gap') !== gap) {
          // SDK setSettings is programmatic: it reflects confirmed controller
          // state without invoking onSettings or sending a thermostat command.
          await this.setSettings({ auto_changeover_gap: gap });
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
    if ((Object.hasOwn(newSettings, 'temperature_control_units') || changedKeys.includes('temperature_control_units')) &&
      !['metric', 'imperial'].includes(newSettings.temperature_control_units)) {
      throw new Error('Select Fahrenheit or Celsius for temperature controls in device settings.');
    }
    const gapChanged = changedKeys.includes('auto_changeover_gap');
    const gap = newSettings.auto_changeover_gap;
    if ((gap !== undefined || gapChanged) && (!Number.isInteger(gap) || gap < 3 || gap > 9)) {
      throw new Error('The auto-changeover gap must be a whole number from 3 to 9 °F.');
    }
    const hostChanged = changedKeys.includes('host') && host !== this._host;
    if (hostChanged && gapChanged) throw new Error('Change the thermostat address separately from the auto-changeover gap.');
    if (gapChanged) {
      if (this.getSetting('read_only') !== false || newSettings.read_only !== false) {
        throw new Error('Save with Read-only mode disabled before changing the auto-changeover gap.');
      }
      await this.writeCommand({ type: 'deadband', value: gap });
    }
    if (hostChanged) {
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
