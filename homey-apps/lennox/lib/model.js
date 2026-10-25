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

function temperatureGap(system, zone) {
  const c = zone.temperatureDeadbandC ?? system.hspCCspCSeparation;
  const f = zone.temperatureDeadbandC != null ? Math.round(c * 9 / 5) : system.hspCspSeparation ?? Math.round(c * 9 / 5);
  if (!finite(c) || c <= 0 || !finite(f) || f <= 0) throw Error('Thermostat temperature separation is unknown');
  return { c, f };
}

function temperaturePair(zone, kind) {
  const key = { heat: 'hsp', cool: 'csp', target: 'sp' }[kind];
  const c = celsius(zone[key + 'C'], zone[key]);
  const f = finite(zone[key]) ? zone[key] : finite(c) ? Math.round(c * 9 / 5 + 32) : undefined;
  if (!finite(c) || !finite(f)) throw Error(`The current ${kind === 'target' ? 'temperature' : kind + 'ing'} target is unknown`);
  return { c, f };
}

function withinFahrenheitLimits(zone, kind, f) {
  const key = kind === 'heat' ? 'Hsp' : 'Csp';
  return (!finite(zone['min' + key]) || f >= zone['min' + key]) && (!finite(zone['max' + key]) || f <= zone['max' + key]);
}

function reportedTemperatureGap(system, zone) {
  const reportedZone = finite(zone.temperatureDeadbandC);
  if (!reportedZone && system.hasTemperatureDeadband !== true) throw Error('The thermostat has not reported its heat/cool separation. Wait for its configuration before changing temperature.');
  const gap = temperatureGap(system, zone);
  if (!Number.isInteger(gap.f) || gap.f < 3 || gap.f > 9 || (!reportedZone &&
    (!Number.isInteger(system.hspCspSeparation) || system.hspCspSeparation < 3 || system.hspCspSeparation > 9))) {
    throw Error('The thermostat heat/cool separation is unknown or outside its supported 3–9°F range');
  }
  return gap;
}

function effectiveTargetLimits(system, zone, kind) {
  if (kind === 'target') {
    const heat = limits(zone, 'heat'), cool = limits(zone, 'cool');
    const min = Math.max(heat.min, cool.min), max = Math.min(heat.max, cool.max);
    if (min >= max) throw Error('Thermostat temperature limits do not overlap');
    return { min, max, step: 0.5 };
  }
  const range = limits(zone, kind), automatic = zone.systemMode === 'heat and cool';
  const gap = automatic ? temperatureGap(system, zone) : null;
  const opposite = automatic ? temperaturePair(zone, kind === 'heat' ? 'cool' : 'heat') : null;
  const allowed = [];
  for (let units = Math.ceil(range.min * 2); units <= Math.floor(range.max * 2); units++) {
    const c = units / 2, f = Math.round(c * 9 / 5 + 32);
    if (!withinFahrenheitLimits(zone, kind, f)) continue;
    if (!automatic || (kind === 'heat' ? c + gap.c <= opposite.c && f + gap.f <= opposite.f : c - gap.c >= opposite.c && f - gap.f >= opposite.f)) allowed.push(c);
  }
  if (allowed.length < 2) throw Error('No adjustable temperature range remains while preserving the opposite target');
  return { min: allowed[0], max: allowed[allowed.length - 1], step: 0.5 };
}

function resolveAdjustment(system, zone, command) {
  if (!command || command.type !== 'adjust' || !['heat', 'cool', 'target'].includes(command.target) ||
    ![-1, 1].includes(command.direction) || !['imperial', 'metric'].includes(command.units)) throw Error('Unsupported temperature adjustment');
  const steps = command.steps === undefined ? 1 : command.steps;
  if (!Number.isInteger(steps) || steps < 1 || steps > 20) throw Error('Temperature adjustments require 1–20 whole steps.');
  const mode = MODES[zone.systemMode];
  if (!mode || mode === 'off') throw Error('Select heating or cooling before adjusting the temperature');
  if (system.singleSetpointMode ? command.target !== 'target' : command.target === 'target') throw Error('This temperature adjustment does not match the thermostat setpoint mode');
  if (command.target !== 'target' && mode !== command.target && mode !== 'auto') throw Error('Use the temperature adjustment for the active thermostat mode');
  const current = temperaturePair(zone, command.target);
  const delta = command.direction * steps;
  const value = command.units === 'imperial' ? (Math.round(current.f) + delta - 32) * 5 / 9 : current.c + delta * 0.5;
  return { type: command.target, value, units: command.units };
}

function candidate(system, zone, host) {
  const serial = system.serialNumber;
  if (typeof serial !== 'string' || !serial.trim() || !Number.isInteger(zone.id)) throw Error('Thermostat identity has not been received');
  const state = normalizeZone(system, zone);
  const capabilities = ['measure_temperature', 'thermostat_mode', 'hvac_state'];
  if ('measure_humidity' in state) capabilities.push('measure_humidity');
  if ('fan_mode' in state) capabilities.push('fan_mode');
  const capabilitiesOptions = {};
  const mode = MODES[zone.systemMode];
  const knownSetpointMode = typeof system.singleSetpointMode === 'boolean';
  let nativeTargets, adjustments;
  if (system.singleSetpointMode === true) nativeTargets = [];
  else if (system.singleSetpointMode === false && mode) nativeTargets = ['heat', 'cool']
    .filter(type => (mode === type || mode === 'auto') && zone[type === 'heat' ? 'heatingOption' : 'coolingOption'] !== false)
    .map(type => `target_temperature.${type}`);
  if (knownSetpointMode && mode) adjustments = [];
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
      const range = effectiveTargetLimits(system, zone, type);
      capabilitiesOptions[type + '_target'] = range;
      capabilities.push(type + '_target');
      if (!nativeTargets?.includes(`target_temperature.${type}`)) continue;
      capabilities.push(`target_temperature.${type}`, `measure_temperature.${type}`, `thermostat_mode.${type}`);
      capabilitiesOptions[`target_temperature.${type}`] = {
        ...range, title: { en: type === 'heat' ? 'Heating target' : 'Cooling target' },
        uiComponent: 'thermostat', preventInsights: true, preventTag: true,
      };
      const helperOptions = { uiComponent: null, preventInsights: true, preventTag: true };
      capabilitiesOptions[`measure_temperature.${type}`] = {
        ...helperOptions, title: { en: type === 'heat' ? 'Heating temperature' : 'Cooling temperature' },
      };
      capabilitiesOptions[`thermostat_mode.${type}`] = helperOptions;
      adjustments?.push(`${type}_decrease`, `${type}_increase`);
    } catch { /* readings remain usable before limits arrive */ }
  }
  // A single thermostat dial is ambiguous for a dual-setpoint system in auto.
  // Show the independent heat/cool controls instead of choosing one silently.
  if (system.singleSetpointMode && finite(state.target_temperature)) {
    try {
      capabilitiesOptions.target_temperature = { ...effectiveTargetLimits(system, zone, 'target'), uiComponent: 'thermostat' };
      capabilities.push('target_temperature');
      if (mode && mode !== 'off') adjustments?.push('target_decrease', 'target_increase');
    } catch { /* no write control until known limits */ }
  }
  for (const id of adjustments || []) { capabilities.push(id); capabilitiesOptions[id] = { uiComponent: 'button' }; }
  return { name: `${system.name || 'Lennox'} — ${zone.name || `Zone ${zone.id + 1}`}`,
    data: { id: `${serial}:${zone.id}` }, settings: { host: validateHost(host), read_only: true },
    store: { serial, zoneId: zone.id }, capabilities, capabilitiesOptions,
    ...(system.hasTemperatureDeadband === true && Number.isInteger(system.hspCspSeparation) ? { changeoverGap: system.hspCspSeparation } : {}),
    ...(nativeTargets === undefined ? {} : { nativeTargets }), ...(adjustments === undefined ? {} : { adjustments }) };
}

function deadbandLimits(parameter) {
  if (!Number.isInteger(parameter?.valueF) || parameter.valueF < 3 || parameter.valueF > 9 || parameter.enabled !== true ||
    !Number.isInteger(parameter.equipmentType) || parameter.equipmentType < 0) throw Error('The thermostat has not reported an editable automatic changeover gap');
  if (parameter.descriptor !== 'range' || (parameter.unit !== undefined && parameter.unit !== 'F')) throw Error('The thermostat has not reported a Fahrenheit range for its automatic changeover gap');
  const numeric = value => typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN;
  const min = numeric(parameter.range?.min), max = numeric(parameter.range?.max), step = numeric(parameter.range?.inc);
  if (![min, max, step].every(finite) || min > max || step <= 0) throw Error('The thermostat automatic changeover gap range is incomplete or invalid');
  const allowed = [];
  for (let value = 3; value <= 9; value++) {
    const steps = value / step;
    if (value >= min && value <= max && Math.abs(steps - Math.round(steps)) < 1e-9) allowed.push(value);
  }
  if (!allowed.length) throw Error('The thermostat automatic changeover gap range does not allow a whole value from 3 to 9°F');
  return { min: allowed[0], max: allowed[allowed.length - 1], step, origin: 0 };
}

function validateDeadbandParameter(value, parameter) {
  if (!Number.isInteger(value) || value < 3 || value > 9) throw Error('Automatic changeover gap must be a whole number from 3 to 9°F');
  const range = deadbandLimits(parameter), steps = (value - range.origin) / range.step;
  if (value < range.min || value > range.max || Math.abs(steps - Math.round(steps)) >= 1e-9) {
    throw Error(`Automatic changeover gap must follow the thermostat's reported range ${range.min}–${range.max}°F and step ${range.step}°F`);
  }
  return range;
}

function planDeadband(system, value, parameter) {
  validateDeadbandParameter(value, parameter);
  if (typeof system.singleSetpointMode !== 'boolean') throw Error('Thermostat setpoint mode is unknown');
  const gapC = Math.round(value * 5 / 9 * 2) / 2;
  const zones = system.zones.filter(zone => !zone.isZoneDisabled && (typeof zone.isZoneActive !== 'function' || zone.isZoneActive()));
  for (const zone of zones) {
    if (!MODES[zone.systemMode]) throw Error('Every active zone must report its operating mode before changing the controller-wide gap');
    if (system.singleSetpointMode || zone.systemMode !== 'heat and cool') continue;
    const heat = temperaturePair(zone, 'heat'), cool = temperaturePair(zone, 'cool');
    if (heat.c + gapC > cool.c || heat.f + value > cool.f) {
      throw Error(`The controller-wide gap cannot change to ${value}°F (${gapC}°C): automatic zone ${zone.name || zone.id + 1} has heating at ${heat.c}°C (${heat.f}°F) and cooling at ${cool.c}°C (${cool.f}°F). Adjust that zone's targets first.`);
    }
  }
  return { valueF: value };
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
    if (value === 'auto' && system.singleSetpointMode === false) {
      const gap = temperatureGap(system, zone), heat = temperaturePair(zone, 'heat'), cool = temperaturePair(zone, 'cool');
      if (heat.c + gap.c > cool.c || heat.f + gap.f > cool.f) {
        throw Error(`Automatic mode requires heating and cooling targets separated by ${gap.c}°C (${gap.f}°F). Current heating is ${heat.c}°C (${heat.f}°F) and cooling is ${cool.c}°C (${cool.f}°F). Adjust the targets before selecting Automatic mode.`);
      }
    }
    period.systemMode = mode; expectedKey = 'thermostat_mode';
  } else if (type === 'fan') {
    if (!FAN_MODES.includes(value) || !FAN_MODES.includes(zone.fanMode)) throw Error('Unsupported fan mode');
    period.fanMode = value; expectedKey = 'fan_mode';
  } else if (['heat', 'cool', 'target'].includes(type)) {
    if (!finite(value)) throw Error('Temperature must be a finite number');
    if (command.units !== undefined && !['imperial', 'metric'].includes(command.units)) throw Error('Unsupported temperature units');
    if (!MODES[zone.systemMode]) throw Error('Thermostat operating mode is unknown. Wait for a fresh reading before changing temperature.');
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
    // A whole Fahrenheit boundary can convert just beyond its rounded Celsius
    // representation. Validate imperial requests after protocol quantization;
    // metric requests must still respect the original, unrounded boundary.
    if (command.units !== 'imperial' && ranges.some(range => value < range.min || value > range.max)) throw Error('Temperature is outside the thermostat limits');
    const rounded = Math.round(value * 2) / 2;
    if (ranges.some(range => rounded < range.min || rounded > range.max)) throw Error('Rounded temperature is outside the thermostat limits');
    const fahrenheit = Math.round(rounded * 9 / 5 + 32);
    if (ranges.some((range, index) => !withinFahrenheitLimits(zone, kind === 'single' ? ['heat', 'cool'][index] : kind, fahrenheit))) throw Error('Temperature is outside the thermostat Fahrenheit limits');
    let inactive;
    if (kind !== 'single' && zone.systemMode === 'heat and cool') {
      const gap = temperatureGap(system, zone), opposite = temperaturePair(zone, kind === 'heat' ? 'cool' : 'heat');
      if (kind === 'heat' ? rounded + gap.c > opposite.c || fahrenheit + gap.f > opposite.f : rounded - gap.c < opposite.c || fahrenheit - gap.f < opposite.f) {
        let allowed = '';
        try {
          const range = effectiveTargetLimits(system, zone, kind), limit = kind === 'heat' ? range.max : range.min;
          allowed = ` ${kind === 'heat' ? 'Maximum heating' : 'Minimum cooling'} target is ${limit}°C (${Math.round(limit * 9 / 5 + 32)}°F).`;
        } catch { /* the opposite target can leave no valid adjustable range */ }
        throw Error(`Heating and cooling targets must retain their temperature separation of ${gap.c}°C (${gap.f}°F). The ${kind === 'heat' ? 'cooling' : 'heating'} target is ${opposite.c}°C (${opposite.f}°F).${allowed}`);
      }
    } else if (kind !== 'single' && zone.heatingOption === true && zone.coolingOption === true) {
      const gap = reportedTemperatureGap(system, zone), other = kind === 'heat' ? 'cool' : 'heat';
      const opposite = temperaturePair(zone, other);
      const separated = (c, f) => kind === 'heat'
        ? c >= rounded + gap.c && f >= fahrenheit + gap.f
        : c <= rounded - gap.c && f <= fahrenheit - gap.f;
      if (!separated(opposite.c, opposite.f)) {
        if (zone.systemMode !== kind) {
          throw Error(`The stored heating and cooling targets require ${gap.c}°C (${gap.f}°F) separation. This change would move the other target; adjust the active target or select its matching operating mode first.`);
        }
        // Lennox's own Heat/Cool controls move the inactive stored target when
        // needed. Find the nearest coherent pair without changing the requested
        // active target, operating mode, schedule, fan, or humidity settings.
        const range = limits(zone, other);
        const candidates = [];
        for (let half = Math.ceil(range.min * 2); half <= Math.floor(range.max * 2); half++) {
          const c = half / 2, f = Math.round(c * 9 / 5 + 32);
          const outward = kind === 'heat' ? c >= opposite.c && f >= opposite.f : c <= opposite.c && f <= opposite.f;
          if (outward && separated(c, f) && withinFahrenheitLimits(zone, other, f)) candidates.push({ c, f });
        }
        inactive = kind === 'heat' ? candidates[0] : candidates.at(-1);
        if (!inactive) throw Error(`The ${other === 'heat' ? 'heating' : 'cooling'} target cannot move far enough within its thermostat limits to preserve the ${gap.c}°C (${gap.f}°F) separation. Choose a smaller temperature change.`);
        inactive = { key: other === 'heat' ? 'hsp' : 'csp',
          celsius: inactive.c, fahrenheit: inactive.f, units: command.units ?? 'metric' };
        period[inactive.key + 'C'] = inactive.celsius; period[inactive.key] = inactive.fahrenheit;
      }
    }
    const key = { heat: 'hsp', cool: 'csp', single: 'sp' }[kind];
    period[key + 'C'] = rounded; period[key] = fahrenheit;
    expectedKey = kind === 'single' ? 'target_temperature' : kind + '_target'; expectedValue = rounded;
    const temperature = { key, celsius: rounded, fahrenheit, units: command.units ?? 'metric' };
    return { data: { schedules: [{ id: scheduleId, schedule: { periods: [{ id: 0, period }] } }] }, expectedKey, expectedValue,
      temperature, temperatures: inactive ? [temperature, inactive] : [temperature] };
  } else throw Error('Unsupported thermostat command');
  return { data: { schedules: [{ id: scheduleId, schedule: { periods: [{ id: 0, period }] } }] }, expectedKey, expectedValue };
}

module.exports = { validateHost, normalizeZone, candidate, planCommand, planDeadband, deadbandLimits, validateDeadbandParameter, limits, effectiveTargetLimits, resolveAdjustment };
