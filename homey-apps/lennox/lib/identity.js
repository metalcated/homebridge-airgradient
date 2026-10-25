'use strict';

const MODELS = new Set(['S30', 'S40', 'E30', 'M30']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function serial(value) {
  if (typeof value !== 'string') return null;
  value = value.trim();
  return value && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value) ? value : null;
}

function model(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return MODELS.has(normalized) ? normalized : null;
}

function id(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function unique(values, description) {
  const found = [...new Set(values.filter(Boolean))];
  if (found.length > 1) throw Error(`Ambiguous Lennox ${description}; more than one identity was reported`);
  return found[0] || null;
}

function mergeFeatures(target, incoming) {
  if (!Array.isArray(incoming)) return;
  for (const item of incoming) {
    if (!object(item) || !object(item.feature)) continue;
    const featureId = id(item.id), fid = id(item.feature.fid);
    if (featureId === null && fid === null) continue;
    const key = featureId === null ? `fid:${fid}` : `id:${featureId}`;
    const previous = target.get(key) || {};
    const merged = { ...previous, ...item.feature };
    if (Array.isArray(item.feature.values)) {
      const values = new Map((Array.isArray(previous.values) ? previous.values : []).map((value, index) => [id(value.id) ?? `index:${index}`, value]));
      for (const [index, value] of item.feature.values.entries()) {
        if (object(value)) values.set(id(value.id) ?? `index:${index}`, { ...values.get(id(value.id) ?? `index:${index}`), ...value });
      }
      merged.values = [...values.values()];
    }
    target.set(key, merged);
  }
}

function featureValues(entity, fid, normalize) {
  const values = [];
  for (const feature of entity?.features?.values() || []) {
    if (id(feature.fid) !== fid || !Array.isArray(feature.values)) continue;
    // The Lennox control identity features have one value at index/id zero.
    const entries = feature.values.filter(value => object(value) && (id(value.id) === 0 || feature.values.length === 1));
    for (const entry of entries) values.push(normalize(entry.value));
  }
  return values;
}

/**
 * Decode identity fields omitted by lennoxapi 0.1.2. The original Python API
 * identifies thermostat devices with deviceType 500 and serial feature fid 9.
 * S40 uses equipment 0's control serial instead. These caches handle the
 * protocol's fragmented feature messages without borrowing peripheral IDs.
 */
class IdentityTracker {
  constructor() {
    this.devices = new Map();
    this.equipments = new Map();
    this.registration = {};
    this.options = {};
  }

  mergeEntities(target, incoming, child) {
    if (!Array.isArray(incoming)) return;
    for (const wrapper of incoming) {
      const entityId = id(wrapper?.id);
      if (entityId === null || !object(wrapper[child])) continue;
      const data = wrapper[child];
      const previous = target.get(entityId) || { features: new Map() };
      const features = previous.features;
      mergeFeatures(features, data.features);
      target.set(entityId, { ...previous, ...data, features });
    }
  }

  update(data) {
    if (!object(data)) return this.resolve();
    if (object(data.system?.registration)) Object.assign(this.registration, data.system.registration);
    if (object(data.system?.config?.options)) Object.assign(this.options, data.system.config.options);
    this.mergeEntities(this.devices, data.devices, 'device');
    this.mergeEntities(this.equipments, data.equipments, 'equipment');
    return this.resolve();
  }

  resolve() {
    const controllers = [...this.devices.values()].filter(device =>
      id(device.deviceType) === 500 || featureValues(device, 15, value => typeof value === 'string' ? value.trim().toLowerCase() : null).includes('thermostat'));
    const controllerSerial = unique(controllers.flatMap(device => [serial(device.serialNumber), ...featureValues(device, 9, serial)]), 'thermostat serial number');
    const controllerModel = unique(controllers.map(device => model(device.productType)), 'thermostat product type');
    const equipment = this.equipments.get(0);
    const equipmentModel = unique(featureValues(equipment, 32773, model), 'system product type');
    const productType = model(this.registration.productType) || model(this.options.productType) || controllerModel || equipmentModel;
    const registeredSerial = serial(this.registration.serialNumber);
    let controlSerial = null;
    if (productType === 'S40') {
      // Equipment 0 is the subnet/system controller, as in the original API.
      // A known contrary equipment type prevents an unrelated serial fallback.
      const equipmentTypes = featureValues(equipment, 15, value => typeof value === 'string' ? value.trim().toLowerCase() : null).filter(Boolean);
      if (!equipmentTypes.length || equipmentTypes.every(value => value === 'system')) {
        controlSerial = unique(featureValues(equipment, 9, serial), 'system controller serial number');
      }
    }
    return { serial: registeredSerial || controlSerial || controllerSerial, productType };
  }
}

module.exports = { IdentityTracker };
