import { Bonjour, Service } from 'bonjour-service';

export interface DiscoveredDevice {
  serialno: string;
  host: string;
  port: number;
  model?: string;
  firmware?: string;
}

export function discoveryRecord(service: Pick<Service, 'host' | 'port' | 'txt'>): DiscoveredDevice | undefined {
  const serialno = String(service.txt?.serialno ?? '');
  if (!/^[a-z\d_-]{2,64}$/i.test(serialno) || !service.host || !service.port) {
    return undefined;
  }
  return { serialno, host: service.host.replace(/\.$/, ''), port: service.port,
    model: service.txt?.model, firmware: service.txt?.fw_ver };
}

export async function discover(milliseconds = 4000): Promise<DiscoveredDevice[]> {
  let discoveryError: Error | undefined;
  const bonjour = new Bonjour(undefined, (error: Error) => {
    discoveryError = error;
  });
  const devices = new Map<string, DiscoveredDevice>();
  try {
    const browser = bonjour.find({ type: 'airgradient' }, service => {
      const device = discoveryRecord(service);
      if (device) {
        devices.set(device.serialno, device);
      }
    });
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    browser.stop();
    if (discoveryError) {
      throw new Error('Discovery is unavailable on this network. Enter a hostname or IP address manually.');
    }
    return [...devices.values()];
  } finally {
    bonjour.destroy();
  }
}
