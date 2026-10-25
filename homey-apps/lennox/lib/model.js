'use strict';

const { isIP } = require('node:net');
const MODES = { off: 'off', heat: 'heat', cool: 'cool', 'heat and cool': 'auto' };
const FAN_MODES = ['auto', 'on', 'circulate'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const good = status => status == null || status === 'good';
const celsius = (c, f) => finite(c) ? c : finite(f) ? (f - 32) * 5 / 9 : undefined;

function validateHost(host) {
  if (typeof host !== 'string') throw Error('Enter a thermostat IP address or hostname');
  host = host.trim();
  if (!host || host.length > 253 || (!isIP(host) &&
    (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
      host.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
      /^[\d.]+$/.test(host)))) throw Error('Enter an IP address or hostname without a URL, port, or path');
  return host.toLowerCase();
}

function normalizeZone(system, zone) {
  const state = {};
  const temperature = celsius(zone.temperatureC, zone.temperature);
  if (finite(temperature) && temperature >= -40 && temperature <= 80 && good(zone.temperatureStatus)) state.measure_temperature = temperature;
  if (finite(zone.humidity) && zone.humidity >= 0 && zone.humidity <= 100 && good(zone.humidityStatus)) state.measure_humidity = zone.humidity;
  if (MODES[zone.systemMode]) state.thermostat_mode = MODES[zone.systemMode];
  const heat = celsius(zone.hspC, zone.hsp), cool = celsius(zone.cspC, zone.csp), single = celsius(zone.spC, zone.sp);
  if (!system.singleSetpointMode && zone.heatingOption === true && finite(heat)) state.heat_target = heat;
  if (!system.singleSetpointMode && zone.coolingOption === true && finite(cool)) state.cool_target = cool;
  if ('measure_temperature' in state) {
    for (const type of ['heat', 'cool']) state[`measure_temperature.${type}`] = state.measure_temperature;
  }
  if (!system.singleSetpointMode) {
    for (const type of ['heat', 'cool']) {
      if (type + '_target' in state) state[`target_temperature.${type}`] = state[type + '_target'];
      // Homey's native thermostat groups read matching mode/temperature suffixes.
      // These hidden modes describe enabled directions, not actual HVAC demand.
      const supported = zone[type === 'heat' ? 'heatingOption' : 'coolingOption'];
      state[`thermostat_mode.${type}`] = supported !== false && (state.thermostat_mode === type || state.thermostat_mode === 'auto') ? type : 'off';
    }
  } else if (system.singleSetpointMode === true) {
    state['thermostat_mode.heat'] = 'off';
    state['thermostat_mode.cool'] = 'off';
  }
  const target = system.singleSetpointMode ? single : zone.systemMode === 'heat' ? heat : zone.systemMode === 'cool' ? cool : undefined;
  if (finite(target)) state.target_temperature = target;
  else if (system.singleSetpointMode === false && ['off', 'heat and cool'].includes(zone.systemMode)) state.target_temperature = null;
  state.hvac_state = { heating: 'heating', cooling: 'cooling', off: 'idle', idle: 'idle', defrost: 'defrost' }[zone.tempOperation] || 'unknown';
  if (FAN_MODES.includes(zone.fanMode)) state.fan_mode = zone.fanMode;
  return state;
}

function limits(zone, kind) {
  const heat = kind === 'heat';
  const min = celsius(zone[heat ? 'minHspC' : 'minCspC'], zone[heat ? 'minHsp' : 'minCsp']);
  const max = celsius(zone[heat ? 'maxHspC' : 'maxCspC'], zone[heat ? 'maxHsp' : 'maxCsp']);
  if (!finite(min) || !finite(max) || min >= max || min < 0 || max > 50) throw Error('Thermostat temperature limits have not been received');
  return { min, max, step: 0.5 };
}

function candidate(system, zone, host) {
  const serial = system.serialNumber;
  if (typeof serial !== 'string' || !serial.trim() || !Number.isInteger(zone.id)) throw Error('Thermostat identity has not been received');
  const state = normalizeZone(system, zone);
  const capabilities = ['measure_temperature', 'thermostat_mode', 'hvac_state'];
  if ('measure_humidity' in state) capabilities.push('measure_humidity');
  if ('fan_mode' in state) capabilities.push('fan_mode');
  const capabilitiesOptions = {};
  if (system.singleSetpointMode === true) {
    for (const type of ['heat', 'cool']) capabilitiesOptions[`target_temperature.${type}`] = { uiComponent: null };
  } else if (system.singleSetpointMode === false) capabilitiesOptions.target_temperature = { uiComponent: null };
  const modes = ['off'];
  if (zone.heatingOption === true) modes.push('heat');
  if (zone.coolingOption === true) modes.push('cool');
  if (zone.heatingOption === true && zone.coolingOption === true) modes.push('auto');
  if (typeof zone.heatingOption === 'boolean' && typeof zone.coolingOption === 'boolean') {
    capabilitiesOptions.thermostat_mode = { values: modes.map(id => ({ id, title: { en: id === 'auto' ? 'Automatic' : id[0].toUpperCase() + id.slice(1) } })) };
  }
  for (const type of ['heat', 'cool']) {
    if (zone[type === 'heat' ? 'heatingOption' : 'coolingOption'] === false) {
      capabilitiesOptions[`target_temperature.${type}`] = { uiComponent: null };
    }
    if (!(type + '_target' in state)) continue;
    try {
      const range = limits(zone, type);
      capabilitiesOptions[type + '_target'] = range;
      capabilities.push(type + '_target', `target_temperature.${type}`, `measure_temperature.${type}`, `thermostat_mode.${type}`);
      capabilitiesOptions[`target_temperature.${type}`] = {
        ...range, title: { en: type === 'heat' ? 'Heating target' : 'Cooling target' },
        uiComponent: 'thermostat', preventInsights: true, preventTag: true,
      };
      const helperOptions = { uiComponent: null, preventInsights: true, preventTag: true };
      capabilitiesOptions[`measure_temperature.${type}`] = {
        ...helperOptions, title: { en: type === 'heat' ? 'Heating temperature' : 'Cooling temperature' },
      };
      capabilitiesOptions[`thermostat_mode.${type}`] = helperOptions;
    } catch { /* readings remain usable before limits arrive */ }
  }
  // A single thermostat dial is ambiguous for a dual-setpoint system in auto.
  // Show the independent heat/cool controls instead of choosing one silently.
  if (system.singleSetpointMode && finite(state.target_temperature)) {
    try {
      const heat = limits(zone, 'heat'), cool = limits(zone, 'cool');
      capabilitiesOptions.target_temperature = { min: Math.max(heat.min, cool.min), max: Math.min(heat.max, cool.max), step: 0.5, uiComponent: 'thermostat' };
      if (capabilitiesOptions.target_temperature.min < capabilitiesOptions.target_temperature.max) capabilities.push('target_temperature');
    } catch { /* no write control until known limits */ }
  }
  return { name: `${system.name || 'Lennox'} — ${zone.name || `Zone ${zone.id + 1}`}`,
    data: { id: `${serial}:${zone.id}` }, settings: { host: validateHost(host), read_only: true },
    store: { serial, zoneId: zone.id }, capabilities, capabilitiesOptions };
}

// Commands are partial protocol updates. The upstream full-period builder fills
// missing humidity/fan/temperature values with defaults, which we must not send.
function planCommand(system, zone, command) {
  const { type, value } = command || {};
  if (zone.localWriteAccess !== undefined && zone.localWriteAccess !== 'openAll') throw Error('This thermostat zone does not grant local write access');
  if (zone.isZoneDisabled || (typeof zone.isZoneActive === 'function' && !zone.isZoneActive())) throw Error('This thermostat zone is disabled');
  const manualAway = system.manualAwayMode === true || system.getAwayMode?.() === true;
  if (manualAway) throw Error('Turn off Away at the thermostat before changing this zone; its Away schedule may be shared with other zones');
  const scheduleId = zone.getManualModeScheduleId();
  if (Number.isInteger(zone.scheduleId) && zone.scheduleId !== scheduleId) throw Error('Select Manual mode at the thermostat before using Homey controls. Homey will not replace an active schedule.');
  const period = {};
  let expectedKey, expectedValue = value;
  if (type === 'mode') {
    const mode = Object.keys(MODES).find(key => MODES[key] === value);
    if (!mode) throw Error('Unsupported thermostat mode');
    if ((value === 'heat' || value === 'auto') && zone.heatingOption !== true) throw Error('Heating is not supported');
    if ((value === 'cool' || value === 'auto') && zone.coolingOption !== true) throw Error('Cooling is not supported');
    period.systemMode = mode; expectedKey = 'thermostat_mode';
  } else if (type === 'fan') {
    if (!FAN_MODES.includes(value) || !FAN_MODES.includes(zone.fanMode)) throw Error('Unsupported fan mode');
    period.fanMode = value; expectedKey = 'fan_mode';
  } else if (['heat', 'cool', 'target'].includes(type)) {
    if (!finite(value)) throw Error('Temperature must be a finite number');
    let kind = type;
    if (system.singleSetpointMode) {
      if (type !== 'target') throw Error('Use the single temperature target for this thermostat');
      kind = 'single';
    } else if (type === 'target') {
      kind = zone.systemMode === 'heat' ? 'heat' : zone.systemMode === 'cool' ? 'cool' : null;
      if (!kind) throw Error('Use the separate heating and cooling targets in automatic mode');
    }
    if (kind === 'heat' && zone.heatingOption !== true || kind === 'cool' && zone.coolingOption !== true) throw Error('This temperature control is not supported');
    const ranges = kind === 'single' ? [limits(zone, 'heat'), limits(zone, 'cool')] : [limits(zone, kind)];
    if (ranges.some(range => value < range.min || value > range.max)) throw Error('Temperature is outside the thermostat limits');
    const rounded = Math.round(value * 2) / 2;
    if (ranges.some(range => rounded < range.min || rounded > range.max)) throw Error('Rounded temperature is outside the thermostat limits');
    const separation = zone.temperatureDeadbandC ?? system.hspCCspCSeparation;
    if (kind !== 'single') {
      if (!finite(separation) || separation <= 0) throw Error('Thermostat temperature separation is unknown');
      const opposite = kind === 'heat' ? celsius(zone.cspC, zone.csp) : celsius(zone.hspC, zone.hsp);
      if (!finite(opposite) || (kind === 'heat' ? rounded + separation > opposite : rounded - separation < opposite)) throw Error('Heating and cooling targets must retain their temperature separation');
    }
    const key = { heat: 'hsp', cool: 'csp', single: 'sp' }[kind];
    period[key + 'C'] = rounded; period[key] = Math.round(rounded * 9 / 5 + 32);
    expectedKey = kind === 'single' ? 'target_temperature' : kind + '_target'; expectedValue = rounded;
  } else throw Error('Unsupported thermostat command');
  return { data: { schedules: [{ id: scheduleId, schedule: { periods: [{ id: 0, period }] } }] }, expectedKey, expectedValue };
}

module.exports = { validateHost, normalizeZone, candidate, planCommand, limits };
