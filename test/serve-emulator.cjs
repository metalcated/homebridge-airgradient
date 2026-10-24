const readline = require('node:readline');
const { emulator, LEGACY, V1 } = require('./emulator.cjs');
(async () => {
  const device = await emulator(process.argv.includes('--v1') ? 'v1' : 'legacy');
  console.log('Emulated AirGradient monitor. Use this sensor config on the SAME host as Homebridge:');
  console.log(JSON.stringify({ ...device.settings, pollingInterval: 1000, offlineAfterFailures: 2 }, null, 2));
  console.log('Commands: offline, healthy, invalid, high-co2, legacy, v1, quit');
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  const healthy = () => { device.status = 200; device.payload = { ...(device.version === 'v1' ? V1 : LEGACY) }; };
  const close = async () => { input.close(); await device.close(); };
  input.on('line', async line => {
    const command = line.trim();
    if (command === 'offline') { device.status = 503; }
    else if (command === 'invalid') { device.payload = { serialno: 'abc123', rco2: -1 }; }
    else if (command === 'high-co2') { healthy(); device.payload[device.version === 'v1' ? 'co2' : 'rco2'] = 1200; }
    else if (command === 'legacy' || command === 'v1') { device.version = command; healthy(); }
    else if (command === 'healthy') { healthy(); }
    else if (command === 'quit') { await close(); return; }
    else { console.log('Unknown command.'); return; }
    console.log(`Scenario: ${command}`);
  });
  process.once('SIGINT', close);
})().catch(error => { console.error(error); process.exitCode = 1; });
