import axios from 'axios';
import { isIP } from 'net';

export interface DeviceConfig {
  serialno: string;
  host?: string;
  port?: number;
  apiVersion?: 'auto' | 'legacy' | 'v1';
  requestTimeout?: number;
}
export type Payload = Record<string, unknown>;
export const MEASUREMENTS = ['pm02', 'pm10', 'rco2', 'atmp', 'rhum', 'tvocIndex', 'noxIndex', 'battPercent'] as const;

export function record(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Device returned an invalid JSON object');
  }
  return value as Payload;
}

export function baseUrl(config: DeviceConfig): string {
  const host = config.host || `airgradient_${config.serialno}.local`;
  if (!(isIP(host) || /^[a-z\d_][a-z\d_.-]*$/i.test(host)) || host.length > 253) {
    throw new Error('Host must be a hostname or IP address, without a URL, path, or credentials');
  }
  const port = config.port ?? 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

export function normalize(input: unknown, serial: string, version: 'legacy' | 'v1'): Payload {
  const data = record(input);
  const identity = version === 'v1' ? data.serialNumber : data.serialno;
  if (identity !== undefined && String(identity).toLowerCase() !== serial.toLowerCase()) {
    throw new Error('Device serial number does not match the configured sensor');
  }
  const result = { ...data };
  if (version === 'v1') {
    Object.assign(result, { serialno: data.serialNumber, pm02: data.pm25, rco2: data.co2,
      atmp: data.temperature, rhum: data.humidity, wifi: data.wifiRssi });
  }
  if (!MEASUREMENTS.some(key => typeof result[key] === 'number')) {
    throw new Error('Device response contains no recognized measurements');
  }
  return result;
}

export class DeviceClient {
  public version?: 'legacy' | 'v1';
  private stopped = false;
  private readonly controller = new AbortController();
  public readonly url: string;

  constructor(public readonly config: DeviceConfig) {
    this.url = baseUrl(config);
    if (config.apiVersion && config.apiVersion !== 'auto') {
      this.version = config.apiVersion;
    }
  }

  private async request(path: string, method: 'GET' | 'PUT' = 'GET', data?: Payload): Promise<Payload> {
    if (this.stopped) {
      throw new Error('Device client is stopped');
    }
    const response = await axios.request({ url: this.url + path, method, data, timeout: this.config.requestTimeout ?? 10000,
      signal: this.controller.signal, maxRedirects: 0, maxContentLength: 262144, proxy: false,
      headers: { Accept: 'application/json' } });
    return record(response.data);
  }

  async measures(): Promise<Payload> {
    if (this.version) {
      try {
        return normalize(await this.request(this.version === 'v1' ? '/api/v1/measures' : '/measures/current'),
          this.config.serialno, this.version);
      } catch (error) {
        if ((this.config.apiVersion && this.config.apiVersion !== 'auto') || !axios.isAxiosError(error)
          || ![404, 405].includes(error.response?.status ?? 0)) {
          throw error;
        }
        // Firmware can change API generations while Homebridge remains running.
        this.version = undefined;
      }
    }
    try {
      const data = normalize(await this.request('/api/v1/measures'), this.config.serialno, 'v1');
      this.version = 'v1';
      return data;
    } catch (error) {
      // Never conceal timeouts, authentication errors or bad payloads with a fallback.
      if (!axios.isAxiosError(error) || ![404, 405].includes(error.response?.status ?? 0)) {
        throw error;
      }
    }
    const data = normalize(await this.request('/measures/current'), this.config.serialno, 'legacy');
    this.version = 'legacy';
    return data;
  }

  async configuration(): Promise<Payload> {
    if (!this.version) {
      await this.measures();
    }
    return this.request(this.version === 'v1' ? '/api/v1/config' : '/config');
  }

  async brightness(key: 'displayBrightness' | 'ledBarBrightness', value: number): Promise<void> {
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      throw new Error('Brightness must be an integer between 0 and 100');
    }
    const before = await this.configuration();
    if (typeof before[key] !== 'number' || !['local', 'both'].includes(String(before.configurationControl))) {
      throw new Error('This device does not support this control or does not permit local changes');
    }
    await this.request(this.version === 'v1' ? '/api/v1/config' : '/config', 'PUT', { [key]: value });
    // The v1 API applies writes asynchronously. Verify instead of reporting an accepted write as complete.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if ((await this.configuration())[key] === value) {
        return;
      }
    }
    throw new Error('Device did not confirm the brightness change; refresh before retrying');
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
  }
}
