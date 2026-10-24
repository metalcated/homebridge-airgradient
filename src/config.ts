import { baseUrl, DeviceConfig } from './device';

export interface SensorSettings extends DeviceConfig {
  pollingInterval?: number;
  co2AlertThreshold?: number;
  co2ClearThreshold?: number;
  co2AlertDuration?: number;
  useCompensatedValues?: boolean;
  offlineAfterFailures?: number;
  historyDays?: number;
  enableDisplayControls?: boolean;
}

export function validateSensors(input: unknown): SensorSettings[] {
  if (!Array.isArray(input)) {
    throw new Error('Sensors must be an array. Cached accessories have been preserved.');
  }
  const seen = new Set<string>();
  const result: SensorSettings[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || !/^[a-z\d_-]{2,64}$/i.test(String(entry.serialno ?? ''))) {
      throw new Error('Every sensor needs a valid serial number. Cached accessories have been preserved.');
    }
    const sensor = { ...entry, serialno: String(entry.serialno) } as SensorSettings;
    const ranges: Array<[keyof SensorSettings, number, number, boolean]> = [
      ['pollingInterval', 1000, 86400000, true], ['requestTimeout', 100, 60000, true],
      ['offlineAfterFailures', 1, 100, true], ['historyDays', 0, 365, true],
      ['co2AlertThreshold', 1, 100000, false], ['co2ClearThreshold', 0, 100000, false],
      ['co2AlertDuration', 0, 3600000, true],
    ];
    for (const [key, min, max, integer] of ranges) {
      const value = sensor[key];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value)
        || value < min || value > max || (integer && !Number.isInteger(value)))) {
        throw new Error(`Invalid ${key} for ${sensor.serialno}. Cached accessories have been preserved.`);
      }
    }
    for (const key of ['enableDisplayControls', 'useCompensatedValues'] as const) {
      if (sensor[key] !== undefined && typeof sensor[key] !== 'boolean') {
        throw new Error(`${key} must be a boolean`);
      }
    }
    if (sensor.host !== undefined && typeof sensor.host !== 'string') {
      throw new Error('Host must be a string');
    }
    if (sensor.apiVersion !== undefined && !['auto', 'legacy', 'v1'].includes(sensor.apiVersion)) {
      throw new Error('API version must be auto, legacy, or v1');
    }
    if ((sensor.co2ClearThreshold ?? (sensor.co2AlertThreshold ?? 800) - 50) >= (sensor.co2AlertThreshold ?? 800)) {
      throw new Error('CO2 clear threshold must be lower than the alert threshold');
    }
    baseUrl(sensor);
    // Preserve original first-entry-wins behavior for duplicates, including mixed case.
    const key = sensor.serialno.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(sensor);
    }
  }
  return result;
}

export class Co2Alert {
  private active = false;
  private aboveSince?: number;

  constructor(private readonly trigger: number, private readonly clear: number, private readonly duration: number) {}

  update(value: number, now = Date.now()): number {
    if (value <= this.clear) {
      this.active = false;
      this.aboveSince = undefined;
    } else if (value > this.trigger) {
      this.aboveSince ??= now;
      if (now - this.aboveSince >= this.duration) {
        this.active = true;
      }
    } else {
      this.aboveSince = undefined;
    }
    return this.active ? 1 : 0;
  }

  unavailable(): void {
    this.aboveSince = undefined;
  }
}
