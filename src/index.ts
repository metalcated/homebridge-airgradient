import axios from 'axios';
import { DeviceClient, MEASUREMENTS, Payload } from './device';
import { SensorSettings, validateSensors, Co2Alert } from './config';
import { SensorStore } from './storage';
import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Logging,
  HAP,
  WithUUID,
} from 'homebridge';

type CharacteristicClass = WithUUID<typeof Characteristic & { new (): Characteristic }>;

let hap: HAP;
let VocIndex: CharacteristicClass;
let NoxIndex: CharacteristicClass;

function indexCharacteristic(name: string, uuid: string): CharacteristicClass {
  return class extends hap.Characteristic {
    static readonly UUID = uuid;
    constructor() {
      super(name, uuid, { format: hap.Formats.FLOAT, minValue: 1, maxValue: 500,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY] });
    }
  };
}

interface AirGradientData {
  locationId?: number;
  pm01?: number;
  pm02?: number;
  pm02Compensated?: number | null;
  pm10?: number;
  pm003Count?: number;
  atmp?: number;
  atmpCompensated?: number | null;
  rhum?: number;
  rhumCompensated?: number | null;
  rco2?: number;
  tvoc?: number;
  wifi?: number;
  timestamp?: string;
  ledMode?: string;
  ledCo2Threshold1?: number;
  ledCo2Threshold2?: number;
  ledCo2ThresholdEnd?: number;
  serialno?: string | number;
  model?: string | number;
  firmwareVersion?: string | null;
  firmware?: string | null;
  // Only present on models that carry the corresponding sensor.
  tvocIndex?: number;
  noxIndex?: number;
}

interface SensorConfig extends SensorSettings {
  serialno: string;
  co2AlertThreshold?: number;
  pollingInterval?: number;
  useCompensatedValues?: boolean;
  offlineAfterFailures?: number;
}

// Preserve the legacy identifier so Homebridge can translate cached accessories
// to this scoped package when replacing the original plugin.
const PLUGIN_NAME = 'homebridge-airgradient';
const PLATFORM_NAME = 'AirGradientPlatform';

// Consecutive failed polls before a sensor is reported as unavailable in HomeKit.
// At the default 60s interval that is roughly three minutes of silence, long enough
// to ride out a router reboot without flapping the accessory.
const DEFAULT_OFFLINE_AFTER_FAILURES = 3;


class AirGradientPlatform implements DynamicPlatformPlugin {
  public readonly log: Logging;
  public readonly api: API;
  public readonly fetchLogs: boolean;
  public readonly verboseLogs: boolean;
  public store?: SensorStore;
  private readonly sensors: AirGradientSensor[] = [];

  // Keep a stable map of cached and newly-created accessories by UUID
  private readonly accessories = new Map<string, PlatformAccessory>();

  // Persist sensor configs to act on them after didFinishLaunching
  private readonly sensorConfigs: SensorConfig[] = [];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.fetchLogs = config?.fetchLogs ?? true;
    this.verboseLogs = config?.verboseLogs ?? false;

    hap = api.hap;
    VocIndex = indexCharacteristic('VOC Index', '77B8EA10-7C88-4D6B-87B0-3B73F9760301');
    NoxIndex = indexCharacteristic('NOx Index', '77B8EA11-7C88-4D6B-87B0-3B73F9760301');
    this.api.on('shutdown', () => {
      this.sensors.forEach(sensor => sensor.stop());
      this.store?.close();
    });
    try {
      for (const key of ['fetchLogs', 'verboseLogs']) {
        if (config?.[key] !== undefined && typeof config[key] !== 'boolean') {
          throw new Error(`${key} must be a boolean. Cached accessories have been preserved.`);
        }
      }
      const sensors = validateSensors(config?.sensors);
      if (sensors.length !== config.sensors.length) {
        this.log.warn('Duplicate sensor entries ignored; the first entry is used.');
      }
      config = { ...config, sensors };
    } catch (error) {
      this.log.error('Invalid AirGradient configuration:', (error as Error).message);
      return;
    }
    try {
      this.store = new SensorStore(this.api.user.storagePath());
    } catch (error) {
      this.log.warn('Diagnostics/history storage unavailable:', (error as Error).message);
    }

    if (Array.isArray(config?.sensors)) {
      const seen = new Set<string>();

      for (const sensorConfig of config.sensors as SensorConfig[]) {
        if (!sensorConfig?.serialno) {
          continue;
        }

        // Hand-edited config.json can supply a bare number, which hap.uuid.generate rejects.
        const serialno = String(sensorConfig.serialno);

        // Two entries with one serial produce one UUID, so the second registration would
        // collide and both pollers would hit the same device. Keep the first entry.
        if (seen.has(serialno)) {
          this.log.warn(
            `Ignoring duplicate sensor entry for serial number ${serialno}. ` +
            'Each sensor must appear only once; the first entry\'s settings are used.',
          );
          continue;
        }

        seen.add(serialno);
        this.sensorConfigs.push({ ...sensorConfig, serialno });
        this.log.info('Queued sensor for init with serial number:', serialno);
      }
    }

    // Only manipulate accessories after Homebridge has finished launching, so cache restore happens first.
    this.api.on('didFinishLaunching', () => {
      this.log.info('Did finish launching');

      const configuredUuids = new Set<string>();

      for (const sensorConfig of this.sensorConfigs) {
        const uuid = hap.uuid.generate(sensorConfig.serialno);
        configuredUuids.add(uuid);
        const cached = this.accessories.get(uuid);

        if (cached) {
          this.log.info('Restoring existing accessory from cache:', cached.displayName);
          if (!cached.context.serial) {
            cached.context.serial = sensorConfig.serialno;
          }
          this.sensors.push(new AirGradientSensor(this, cached, sensorConfig));
        } else {
          this.log.info('Adding new accessory for serial number:', sensorConfig.serialno);
          const accessory = new this.api.platformAccessory(
            `AirGradient Sensor ${sensorConfig.serialno}`,
            uuid,
          );
          accessory.context.serial = sensorConfig.serialno;
          this.sensors.push(new AirGradientSensor(this, accessory, sensorConfig));
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

          this.accessories.set(uuid, accessory);
        }
      }

      this.removeOrphanedAccessories(configuredUuids);
    });
  }

  // Drops cached accessories whose sensor is no longer in the config, which is the only
  // signal that the user actually wants them gone. A sensor that is merely offline still
  // has its config entry and is left alone -- unregistering it would throw away its room,
  // name, scenes and automations over what may be a temporary network outage.
  private removeOrphanedAccessories(configuredUuids: Set<string>) {
    const orphans: PlatformAccessory[] = [];

    for (const [uuid, accessory] of this.accessories) {
      if (!configuredUuids.has(uuid)) {
        orphans.push(accessory);
        this.accessories.delete(uuid);
      }
    }

    if (orphans.length === 0) {
      return;
    }

    for (const accessory of orphans) {
      this.log.info('Removing accessory no longer present in the config:', accessory.displayName);
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, orphans);
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.accessories.set(accessory.UUID, accessory);
  }
}

// AccessoryInformation characteristics are strings; the AirGradient payload types
// serialno/model as `string | number`, so coerce and drop blanks.
function toInfoString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

// HAP ignores a Model or SerialNumber of 1 character or less and keeps the old value.
function toIdentityString(value: unknown): string | undefined {
  const text = toInfoString(value);
  return text && text.length > 1 ? text : undefined;
}

// The Home app only renders a dotted numeric firmware revision, so pull that out of
// whatever the device reports (e.g. "3.1.9-rc2" -> "3.1.9").
function toFirmwareRevision(value: unknown): string | undefined {
  const text = toInfoString(value);
  const match = text?.match(/\d+(?:\.\d+){0,2}/);
  return match ? match[0] : undefined;
}

// Different AirGradient firmware builds spell this key differently, so try each.
const FIRMWARE_KEYS = ['firmwareVersion', 'firmware', 'fwVersion', 'fwversion'];

function readFirmwareRevision(data: AirGradientData): string | undefined {
  const record = data as unknown as Record<string, unknown>;
  for (const key of FIRMWARE_KEYS) {
    const revision = toFirmwareRevision(record[key]);
    if (revision) {
      return revision;
    }
  }
  return undefined;
}

function isAirGradientData(x: unknown): x is AirGradientData {
  if (x === null || typeof x !== 'object') {
    return false;
  }
  const o = x as Record<string, unknown>;

  // A partial-capability device can legitimately omit most measurement fields.
  return (
    MEASUREMENTS.some(key => typeof o[key] === 'number')
  );
}

class AirGradientSensor {
  private readonly accessory: PlatformAccessory;
  private readonly log: Logging;
  private readonly serialno: string;
  private readonly pollingInterval: number;
  private readonly client: DeviceClient;
  private readonly platform: AirGradientPlatform;
  private readonly settings: SensorConfig;
  private readonly co2Alert: Co2Alert;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private updating = false;
  private readonly missing = new Map<string, number>();
  private readonly fresh = new Map<string, number>();
  private lastSuccess?: number;
  private wifiRssi?: number;
  private lastError?: string;
  private latest: Payload = {};
  private controlsInitialized = false;
  private firmwareLookupWarned = false;
  private consecutiveFailures = 0;
  private offline = false;
  private readonly offlineAfterFailures: number;
  private get service(): Service {
    return this.accessory.getService(hap.Service.AirQualitySensor)
      || this.accessory.addService(hap.Service.AirQualitySensor);
  }

  private get serviceTemp(): Service {
    return this.accessory.getService(hap.Service.TemperatureSensor)
      || this.accessory.addService(hap.Service.TemperatureSensor);
  }

  private get serviceCO2(): Service {
    return this.accessory.getService(hap.Service.CarbonDioxideSensor)
      || this.accessory.addService(hap.Service.CarbonDioxideSensor);
  }

  private get serviceHumid(): Service {
    return this.accessory.getService(hap.Service.HumiditySensor)
      || this.accessory.addService(hap.Service.HumiditySensor);
  }

  private readonly useCompensatedValues: boolean;
  private readonly fetchLogs: boolean;
  private readonly verboseLogs: boolean;

  constructor(platform: AirGradientPlatform, accessory: PlatformAccessory, sensorConfig: SensorConfig) {
    this.accessory = accessory;
    this.platform = platform;
    this.settings = sensorConfig;
    this.client = new DeviceClient(sensorConfig);
    const trigger = sensorConfig.co2AlertThreshold ?? 800;
    this.co2Alert = new Co2Alert(trigger, sensorConfig.co2ClearThreshold ?? Math.max(0, trigger - 50),
      sensorConfig.co2AlertDuration ?? 0);
    this.log = platform.log;
    this.serialno = sensorConfig.serialno;

    this.pollingInterval = (sensorConfig.pollingInterval && sensorConfig.pollingInterval > 0)
      ? sensorConfig.pollingInterval
      : 60000; // Default to 1 minute, must be higher than 0

    this.useCompensatedValues = sensorConfig.useCompensatedValues ?? false;

    this.offlineAfterFailures = (sensorConfig.offlineAfterFailures && sensorConfig.offlineAfterFailures > 0)
      ? Math.floor(sensorConfig.offlineAfterFailures)
      : DEFAULT_OFFLINE_AFTER_FAILURES;

    this.fetchLogs = platform.fetchLogs;
    this.verboseLogs = platform.verboseLogs;

    // Apply whatever identity we already know. On a restart this comes from the cached
    // context, so HomeKit shows the real model and firmware before the first poll lands.
    this.applyAccessoryInformation();

    // Restore existing services now; create new services only when a payload actually
    // carries that capability. A temperature-only device must not gain a broken CO2 sensor.
    this.markReadingsUnavailable('AirGradient sensor has not reported a reading yet', true);
    // Old releases exposed unitless indices as concentrations. Keep cached characteristics
    // unavailable rather than silently changing their meaning or removing user data.
    for (const legacy of [hap.Characteristic.VOCDensity, hap.Characteristic.NitrogenDioxideDensity]) {
      const air = this.accessory.getService(hap.Service.AirQualitySensor);
      if (air?.testCharacteristic(legacy)) {
        air.updateCharacteristic(legacy, new Error('Use the unitless VOC/NOx index instead'));
      }
    }
    for (const characteristic of [VocIndex, NoxIndex]) {
      const air = this.accessory.getService(hap.Service.AirQualitySensor);
      if (air?.testCharacteristic(characteristic)) {
        air.updateCharacteristic(characteristic, new Error('Waiting for a reading'));
      }
    }

    for (const key of ['displayBrightness', 'ledBarBrightness']) {
      const control = this.accessory.getServiceById(hap.Service.Lightbulb, key);
      if (control) {
        const unavailable = () => {
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        };
        for (const characteristic of [hap.Characteristic.On, hap.Characteristic.Brightness]) {
          control.getCharacteristic(characteristic).onGet(unavailable).onSet(unavailable);
          control.updateCharacteristic(characteristic, new Error('Display controls are disabled or not yet verified'));
        }
      }
    }
    this.updateData();
  }

  // Only mark characteristics that exist on previously observed services.
  private coreReadings(): Array<[Service, CharacteristicClass]> {
    const C = hap.Characteristic;
    const definitions: Array<[WithUUID<typeof Service>, CharacteristicClass[]]> = [
      [hap.Service.AirQualitySensor, [C.AirQuality, C.PM2_5Density, C.PM10Density]],
      [hap.Service.TemperatureSensor, [C.CurrentTemperature]],
      [hap.Service.CarbonDioxideSensor, [C.CarbonDioxideLevel, C.CarbonDioxideDetected]],
      [hap.Service.HumiditySensor, [C.CurrentRelativeHumidity]],
      [hap.Service.Battery, [C.BatteryLevel, C.StatusLowBattery]],
    ];
    const readings: Array<[Service, CharacteristicClass]> = [];
    for (const [type, characteristics] of definitions) {
      const service = this.accessory.getService(type);
      if (service) {
        for (const characteristic of characteristics) {
          if (service.testCharacteristic(characteristic)) {
            readings.push([service, characteristic]);
          }
        }
      }
    }
    return readings;
  }

  // Model-dependent readings, created lazily by the first payload that carries them.
  // They are deliberately absent from coreReadings(): a sensor the device doesn't have
  // would otherwise sit in an error state forever and strand the whole accessory on
  // "No Response". Only mark them when they already exist on the service.
  private optionalReadings(): Array<[Service, CharacteristicClass]> {
    const entries: Array<[Service, CharacteristicClass]> = [];

    const service = this.accessory.getService(hap.Service.AirQualitySensor);
    if (service?.testCharacteristic(VocIndex)) {
      entries.push([service, VocIndex]);
    }
    if (service?.testCharacteristic(NoxIndex)) {
      entries.push([service, NoxIndex]);
    }

    return entries;
  }

  // Puts readings into an error state, which HomeKit surfaces as "No Response". Pushing a
  // number instead would look like a real measurement to the Home app and to any automation
  // watching temperature or CO2. The next accepted reading clears the status by itself.
  private markReadingsUnavailable(reason: string, includeOptional = false) {
    const entries = includeOptional
      ? [...this.coreReadings(), ...this.optionalReadings()]
      : this.coreReadings();

    for (const [service, characteristic] of entries) {
      service.updateCharacteristic(characteristic, new Error(reason));
    }
  }

  // Writes the accessory's identity onto the AccessoryInformation service from
  // accessory.context, which Homebridge persists in cachedAccessories.
  private applyAccessoryInformation() {
    const info = this.accessory.getService(hap.Service.AccessoryInformation)
      || this.accessory.addService(hap.Service.AccessoryInformation);

    const context = this.accessory.context;
    const serial = toIdentityString(context.serial) || toIdentityString(this.serialno);
    const model = toIdentityString(context.model) || 'AirGradient Sensor';
    const firmware = toFirmwareRevision(context.firmwareVersion);

    info.setCharacteristic(hap.Characteristic.Manufacturer, 'AirGradient');
    info.setCharacteristic(hap.Characteristic.Model, model);

    if (serial) {
      info.setCharacteristic(hap.Characteristic.SerialNumber, serial);
    } else {
      this.log.warn(
        `Serial number "${this.serialno}" is too short for HomeKit (needs more than 1 character); ` +
        'leaving the SerialNumber characteristic unset.',
      );
    }

    if (firmware) {
      info.setCharacteristic(hap.Characteristic.FirmwareRevision, firmware);
    }
  }

  // The device reports its own model and firmware, but only once a poll succeeds.
  // Cache them on the accessory so the next restart has them immediately.
  private refreshAccessoryInformation(data: AirGradientData) {
    const model = toIdentityString(data.model);
    const firmware = readFirmwareRevision(data);
    const context = this.accessory.context;

    // Surface the payload keys once so an unrecognised firmware field is diagnosable.
    if (!firmware && !this.firmwareLookupWarned) {
      this.firmwareLookupWarned = true;
      this.log.warn(
        'No firmware version found in the AirGradient response; HomeKit will show 0.0.0. ' +
        `Looked for ${FIRMWARE_KEYS.join(', ')}. Keys returned: ${Object.keys(data).join(', ')}`,
      );
    }

    let changed = false;

    if (model && model !== context.model) {
      context.model = model;
      changed = true;
    }

    if (firmware && firmware !== context.firmwareVersion) {
      context.firmwareVersion = firmware;
      changed = true;
    }

    if (changed) {
      this.applyAccessoryInformation();
      this.platform.api.updatePlatformAccessories([this.accessory]);
      this.log.info(
        `Accessory information updated - Model: ${context.model}, ` +
        `Firmware: ${context.firmwareVersion || 'unknown'}, Serial: ${this.serialno}`,
      );
    }
  }

  // Returns the payload, or null if the request failed or the response was unusable.
  // Individual measurements are validated before being presented to HomeKit.
  private async fetchData(): Promise<AirGradientData | null> {
    try {
      const payload = await this.client.measures();
      if (this.stopped) {
        return null;
      }

      if (!isAirGradientData(payload)) {
        if (this.fetchLogs) {
          if (this.verboseLogs) {
            this.log.error('AirGradient API returned unexpected data format:', payload);
          } else {
            this.log.error('AirGradient API returned unexpected data format.');
          }
        }
        return null;
      }

      if (this.fetchLogs) {
        if (this.verboseLogs) {
          this.log.info('Data fetched successfully:', payload);
        } else {
          this.log.debug('Data fetched successfully.');
        }
      }
      this.log.debug('API response:', payload);

      return payload;
    } catch (err) {
      if (!this.stopped) {
        this.lastError = axios.isAxiosError(err)
          ? `${err.code || 'HTTP'}${err.response ? ` ${err.response.status}` : ''}`
          : (err as Error).message;
        this.logFetchError(err);
      }
      return null;
    }
  }

  // Make axios/network errors readable without losing detail.
  private logFetchError(err: unknown) {
    if (!this.fetchLogs) {
      return;
    }

    if (axios.isAxiosError(err)) {
      if (this.verboseLogs) {
        this.log.error(
          `Axios error fetching AirGradient data: ${err.message}` +
          (err.response ? ` (status ${err.response.status})` : '') +
          (err.code ? ` [code ${err.code}]` : ''),
        );
        if (err.response?.data) {
          this.log.debug('Error response body:', err.response.data);
        }
      } else {
        const cause = (err.cause as { address?: string; port?: number; code?: string } | undefined);
        const addr = cause?.address && cause?.port ? ` ${cause.address}:${cause.port}` : '';
        const code = cause?.code || err.code || '';
        const reason = code === 'EHOSTUNREACH' ? 'host unreachable' :
          code === 'ECONNREFUSED' ? 'connection refused' :
            code === 'ETIMEDOUT' ? 'timeout' :
              code === 'ENOTFOUND' ? 'host not found' : err.message;
        this.log.error(`Error fetching data: ${reason}${addr}`);
      }
    } else if (err instanceof Error) {
      if (this.verboseLogs) {
        this.log.error('Error fetching data from AirGradient API:', err.message);
        this.log.debug(err.stack || 'no stack');
      } else {
        this.log.error(`Error fetching data: ${err.message}`);
      }
    } else {
      this.log.error('Unknown error fetching data from AirGradient API:', err);
    }
  }

  private handlePollSuccess(data: AirGradientData) {
    this.wifiRssi = typeof data.wifi === 'number' && Number.isFinite(data.wifi) && data.wifi >= -127 && data.wifi <= 0
      ? data.wifi : undefined;
    this.lastError = undefined;
    this.refreshAccessoryInformation(data);
    this.updateCharacteristics(data);
    if (!Object.keys(this.latest).length) {
      this.lastError = 'No valid measurements in device response';
      this.handlePollFailure();
      return;
    }
    if (this.offline) {
      this.log.info(`Sensor ${this.serialno} is responding again after ${this.consecutiveFailures} failed attempts.`);
      this.offline = false;
    }
    this.consecutiveFailures = 0;
    if (!this.controlsInitialized && this.settings.enableDisplayControls) {
      this.controlsInitialized = true;
      void this.setupControls().catch(error => {
        this.controlsInitialized = false;
        this.log.debug('Display controls unavailable:', (error as Error).message);
      });
    }
  }

  // A single missed poll is usually a Wi-Fi hiccup, so hold the last known readings and only
  // report the sensor as unavailable once it has stayed silent for the configured number of
  // attempts. An unusable payload counts too: the device answered, but told us nothing usable.
  private handlePollFailure() {
    this.consecutiveFailures++;

    if (this.offline) {
      return;
    }

    if (this.consecutiveFailures < this.offlineAfterFailures) {
      this.log.debug(
        `Poll failed (${this.consecutiveFailures} of ${this.offlineAfterFailures} before the sensor is marked offline).`,
      );
      return;
    }

    this.offline = true;
    this.co2Alert.unavailable();
    this.log.warn(
      `No usable response from sensor ${this.serialno} after ${this.consecutiveFailures} consecutive attempts; ` +
      'reporting it as unavailable in HomeKit until it responds again.',
    );
    this.markReadingsUnavailable(`AirGradient sensor ${this.serialno} is not responding`, true);
  }

  private async updateData() {
    if (this.stopped || this.updating) {
      return;
    }
    clearTimeout(this.timer);
    this.updating = true;
    try {
      const data = await this.fetchData();
      if (this.stopped) {
        return;
      }
      if (data) {
        this.handlePollSuccess(data);
      } else {
        this.handlePollFailure();
      }
    } catch (err) {
      // fetchData swallows its own errors, so anything here is a bug on the update path.
      // Catch it regardless so a single bad poll can't stop the polling loop.
      this.log.debug('Unexpected error while updating accessory:', err);
      this.lastError = 'Accessory update failed';
      this.handlePollFailure();
    } finally {
      this.updating = false;
      if (!this.stopped) {
        this.persistDiagnostics();
        this.timer = setTimeout(() => this.updateData(), this.pollingInterval);
      }
    }
  }

  // Falls back to the raw reading when compensation is off or the device left the
  // compensated field null, which is better than pushing an empty value to HomeKit.
  private preferred(
    compensated: number | undefined | null, raw: number | undefined, min = 0, max = Number.POSITIVE_INFINITY,
  ): number | undefined {
    return this.useCompensatedValues && typeof compensated === 'number' && Number.isFinite(compensated)
      && compensated >= min && compensated <= max
      ? compensated
      : raw;
  }

  // Pushes one reading, returning whether it was actually accepted.
  // A sensor the device doesn't carry is absent from the payload, and some readings come
  // back below their valid range when the sensor is warming up or faulted; neither is worth
  // a warning every polling interval, so they are logged at debug and left unchanged.
  private applyReading(
    service: Service,
    characteristic: CharacteristicClass,
    label: string,
    value: number | undefined,
    min = 0,
    max = Number.POSITIVE_INFINITY,
  ): boolean {
    const invalid = () => {
      const missed = (this.missing.get(label) ?? 0) + 1;
      this.missing.set(label, missed);
      if (missed >= this.offlineAfterFailures || !this.fresh.has(label)) {
        service.updateCharacteristic(characteristic, new Error(`${label} is unavailable or stale`));
      }
      return false;
    };
    if (value === undefined || value === null) {
      this.log.debug(`${label} not reported by this device; leaving characteristic unchanged.`);
      return service.testCharacteristic(characteristic) ? invalid() : false;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.log.debug(`Invalid ${label} value:`, value);
      return invalid();
    }

    if (value < min || value > max) {
      this.log.debug(`${label} reported as ${value}, outside the valid range ${min} to ${max}; ignoring.`);
      return invalid();
    }

    this.missing.set(label, 0);
    this.fresh.set(label, Date.now());
    if (!service.testCharacteristic(characteristic)) {
      service.addCharacteristic(characteristic);
    }
    service.updateCharacteristic(characteristic, value);
    return true;
  }

  private updateCharacteristics(data: AirGradientData) {
    // Use compensated values if enabled and available, otherwise fall back to the raw values
    const pm2_5 = this.preferred(data.pm02Compensated, data.pm02, 0, 1000);
    const temp = this.preferred(data.atmpCompensated, data.atmp, -270, 100);
    const humidity = this.preferred(data.rhumCompensated, data.rhum, 0, 100);

    const { pm10, tvocIndex: tvoc, noxIndex: nox, rco2: co2 } = data;
    const C = hap.Characteristic;

    const hasAir = [data.pm02, data.pm10, tvoc, nox].some(value => value !== undefined)
      || !!this.accessory.getService(hap.Service.AirQualitySensor);
    const hasCo2 = co2 !== undefined || !!this.accessory.getService(hap.Service.CarbonDioxideSensor);
    const pm2_5Applied = hasAir && this.applyReading(this.service, C.PM2_5Density, 'PM2.5', pm2_5, 0, 1000);
    if (hasAir) {
      this.applyReading(this.service, C.PM10Density, 'PM10', pm10, 0, 1000);
      this.applyReading(this.service, VocIndex, 'TVOC', tvoc, 1, 500);
      this.applyReading(this.service, NoxIndex, 'NOx', nox, 1, 500);
    }
    if (humidity !== undefined || this.accessory.getService(hap.Service.HumiditySensor)) {
      this.applyReading(this.serviceHumid, C.CurrentRelativeHumidity, 'Humidity', humidity, 0, 100);
    }
    // HomeKit's valid range for temperature starts at -270C, not 0.
    if (temp !== undefined || this.accessory.getService(hap.Service.TemperatureSensor)) {
      this.applyReading(this.serviceTemp, C.CurrentTemperature, 'Temperature', temp, -270, 100);
    }
    const co2Applied = hasCo2 && this.applyReading(this.serviceCO2, C.CarbonDioxideLevel, 'CO2', co2, 1, 100000);

    // These two are derived, so only recompute them when their source reading was accepted.
    // Feeding NaN to calculateAirQuality() would fall through every comparison and report POOR.
    if (pm2_5Applied) {
      this.service.updateCharacteristic(C.AirQuality, this.calculateAirQuality(pm2_5!));
    } else if (hasAir && (this.missing.get('PM2.5') ?? 0) > 0
      && (!this.fresh.has('PM2.5') || (this.missing.get('PM2.5') ?? 0) >= this.offlineAfterFailures)) {
      this.service.updateCharacteristic(C.AirQuality, new Error('PM2.5 is stale'));
    }
    if (co2Applied) {
      this.serviceCO2.updateCharacteristic(C.CarbonDioxideDetected, this.calculateCO2Detected(co2!));
    } else if (hasCo2) {
      this.co2Alert.unavailable();
      if (!this.fresh.has('CO2') || (this.missing.get('CO2') ?? 0) >= this.offlineAfterFailures) {
        this.serviceCO2.updateCharacteristic(C.CarbonDioxideDetected, new Error('CO2 is stale'));
      }
    }
    if (typeof (data as Payload).battPercent === 'number') {
      const battery = this.accessory.getService(hap.Service.Battery)
        || this.accessory.addService(hap.Service.Battery);
      const level = (data as Payload).battPercent as number;
      if (this.applyReading(battery, C.BatteryLevel, 'Battery', level, 0, 100)) {
        battery.updateCharacteristic(C.StatusLowBattery, level <= 20 ? 1 : 0);
        // Voltage alone cannot establish whether the battery is charging.
      }
    } else {
      const battery = this.accessory.getService(hap.Service.Battery);
      if (battery) {
        this.applyReading(battery, C.BatteryLevel, 'Battery', undefined, 0, 100);
        if ((this.missing.get('Battery') ?? 0) >= this.offlineAfterFailures) {
          battery.updateCharacteristic(C.StatusLowBattery, new Error('Battery status is stale'));
        }
      }
    }
    const values: Payload = { pm02: pm2_5, pm10, rco2: co2, atmp: temp, rhum: humidity,
      tvocIndex: tvoc, noxIndex: nox, battPercent: (data as Payload).battPercent };
    this.latest = {};
    const labels = ['PM2.5', 'PM10', 'CO2', 'Temperature', 'Humidity', 'TVOC', 'NOx', 'Battery'];
    Object.entries(values).forEach(([key, value], index) => {
      if (this.missing.get(labels[index]) === 0 && typeof value === 'number') {
        this.latest[key] = value;
      }
    });
    if (Object.keys(this.latest).length) {
      this.lastSuccess = Date.now();
      try {
        this.platform.store?.append(this.serialno, this.latest, this.settings.historyDays ?? 0);
      } catch (error) {
        this.log.debug('History write failed:', (error as Error).message);
      }
    }

    if (this.fetchLogs) {
      if (this.verboseLogs) {
        this.log.info(`Updated characteristics - PM2.5: ${pm2_5}, PM10: ${pm10}, TVOC: ${tvoc}, ` +
          `NOx: ${nox}, TEMP: ${temp}, CO2: ${co2}, Humidity: ${humidity}`);
      } else {
        this.log.debug('Updated characteristics.');
      }
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.client.stop();
  }

  private persistDiagnostics(): void {
    try {
      this.platform.store?.diagnostics(this.serialno, { serialno: this.serialno, model: this.accessory.context.model,
        firmware: this.accessory.context.firmwareVersion, apiVersion: this.client.version, lastSuccess: this.lastSuccess,
        lastAttempt: Date.now(), failures: this.consecutiveFailures, offline: this.offline,
        lastError: this.lastError, wifiRssi: this.wifiRssi, readingTimes: Object.fromEntries(this.fresh), values: this.latest });
    } catch (error) {
      this.log.debug('Diagnostics write failed:', (error as Error).message);
    }
  }

  private async writeBrightness(key: 'displayBrightness' | 'ledBarBrightness', value: number): Promise<void> {
    try {
      await this.client.brightness(key, value);
    } catch (error) {
      this.log.debug('Brightness write failed:', (error as Error).message);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async setupControls(): Promise<void> {
    const config = await this.client.configuration();
    if (this.stopped || !['local', 'both'].includes(String(config.configurationControl))) {
      return;
    }
    for (const key of ['displayBrightness', 'ledBarBrightness'] as const) {
      if (typeof config[key] !== 'number') {
        continue;
      }
      const name = key === 'displayBrightness' ? 'AirGradient Display' : 'AirGradient LED Bar';
      const service = this.accessory.getServiceById(hap.Service.Lightbulb, key)
        || this.accessory.addService(hap.Service.Lightbulb, name, key);
      const read = async () => {
        const value = (await this.client.configuration())[key];
        if (typeof value !== 'number') {
          throw new Error('Brightness is unavailable');
        }
        return value;
      };
      service.getCharacteristic(hap.Characteristic.Brightness).onGet(read).onSet(async value => {
        await this.writeBrightness(key, Number(value));
        service.updateCharacteristic(hap.Characteristic.On, Number(value) > 0);
      });
      service.getCharacteristic(hap.Characteristic.On).onGet(async () => (await read()) > 0).onSet(async value => {
        const target = value ? (Number(this.accessory.context[key]) || 100) : 0;
        const previous = await read();
        if (previous > 0) {
          this.accessory.context[key] = previous;
        }
        await this.writeBrightness(key, target);
        service.updateCharacteristic(hap.Characteristic.Brightness, target);
      });
      service.updateCharacteristic(hap.Characteristic.Brightness, config[key] as number);
      service.updateCharacteristic(hap.Characteristic.On, (config[key] as number) > 0);
    }
  }

  private calculateAirQuality(pm2_5: number): number {
    if (pm2_5 <= 12) {
      return hap.Characteristic.AirQuality.EXCELLENT;
    } else if (pm2_5 <= 35.4) {
      return hap.Characteristic.AirQuality.GOOD;
    } else if (pm2_5 <= 55.4) {
      return hap.Characteristic.AirQuality.FAIR;
    } else if (pm2_5 <= 150.4) {
      return hap.Characteristic.AirQuality.INFERIOR;
    } else {
      return hap.Characteristic.AirQuality.POOR;
    }
  }

  private calculateCO2Detected(co2: number): number {
    return this.co2Alert.update(co2);
  }

}

export = (homebridge: API) => {
  hap = homebridge.hap;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AirGradientPlatform);
};
