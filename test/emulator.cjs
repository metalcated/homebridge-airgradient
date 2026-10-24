const http = require('node:http');

const LEGACY = { serialno: 'abc123', model: 'I-9PSL', firmware: '3.1.9', wifi: -52,
  pm02: 7, pm10: 10, rco2: 600, atmp: 22, rhum: 48, tvocIndex: 100, noxIndex: 1 };
const V1 = { serialNumber: 'abc123', model: 'P-1PSG', firmware: '1.2.3', wifiRssi: -55,
  pm25: 7, pm10: 10, co2: 600, temperature: 22, humidity: 48, tvocIndex: 100, noxIndex: 1, battPercent: 72 };

async function emulator(version = 'legacy') {
  const state = { version, payload: { ...(version === 'v1' ? V1 : LEGACY) }, requests: [], status: 200,
    config: { configurationControl: 'local', displayBrightness: 50, ledBarBrightness: 40, temperatureUnit: 'c', mqttBrokerUrl: 'mqtt://secret' },
    writeStatus: 200, applyWrite: true, delay: 0, configDelay: 0 };
  const server = http.createServer(async (req, res) => {
    state.requests.push({ method: req.method, path: req.url });
    const measures = state.version === 'v1' ? '/api/v1/measures' : '/measures/current';
    const config = state.version === 'v1' ? '/api/v1/config' : '/config';
    if (![measures, config].includes(req.url)) { res.writeHead(404).end('{}'); return; }
    if (state.delay) { await new Promise(resolve => setTimeout(resolve, state.delay)); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === measures) { res.writeHead(state.status).end(typeof state.payload === 'string' ? state.payload : JSON.stringify(state.payload)); return; }
    if (req.method === 'PUT') {
      let body = ''; for await (const chunk of req) { body += chunk; }
      const patch = JSON.parse(body); state.requests.at(-1).body = patch;
      if (state.applyWrite && state.writeStatus < 400) {
        if (state.configDelay) { setTimeout(() => Object.assign(state.config, patch), state.configDelay); }
        else { Object.assign(state.config, patch); }
      }
      res.writeHead(state.writeStatus).end('{}'); return;
    }
    res.end(JSON.stringify(state.config));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.settings = { serialno: 'abc123', host: '127.0.0.1', port: server.address().port, requestTimeout: 500 };
  state.close = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return state;
}
module.exports = { emulator, LEGACY, V1 };
