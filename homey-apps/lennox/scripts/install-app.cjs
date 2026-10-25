'use strict';

const path = require('node:path');

async function verifyInstalled({ getApp, version, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 30000 }) {
  const until = now() + timeoutMs;
  do {
    const app = await getApp();
    if (app.version !== version) throw Error('Homey did not install the expected Lennox version');
    if (app.crashed || app.state === 'crashed') throw Error(`Lennox failed to start: ${app.crashedMessage || 'check Homey app logs'}`);
    if (app.enabled === false) throw Error('The installed Lennox app is disabled');
    if (app.state === 'running') return app;
    await sleep(1000);
  } while (now() < until);
  throw Error('Lennox was installed but Homey did not report it running in time');
}

function validateInstallUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('The installation override must be a localhost tunnel address without credentials or a path');
  }
  return url.origin;
}

async function configureRoute(homey, value, fetchImpl = fetch) {
  if (!value) return;
  const origin = validateInstallUrl(value);
  const response = await fetchImpl(`${origin}/api/manager/system/ping?id=${encodeURIComponent(homey.id)}`, {
    headers: { 'X-Homey-ID': homey.id }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || response.headers.get('x-homey-id') !== homey.id || (await response.text()).trim() !== 'true') {
    throw Error('The tunnel does not lead to the selected Homey');
  }
  // Same per-instance route override used by the pinned CLI for USB Homeys.
  // Keep account credentials in the existing CLI store; do not export a token.
  homey.__baseUrlPromise = Promise.resolve(origin);
  await homey.sessions.getSessionMe({ $cache: false, $socket: false });
}

async function installApp({ homey, root = path.resolve(__dirname, '..') }) {
  const manifest = require(path.join(root, 'app.json'));
  const App = require('homey/lib/App');
  const app = new App(root);
  await app.preprocess();
  if (await app._validate() !== true) throw Error('The app did not pass Homey validation');
  const archive = await app._getPackStream(); // Defaults to .homeybuild, never the source tree.
  console.log(`Installing ${manifest.id} on ${homey.name}`);
  // Invoke the same SDK endpoint directly because CLI 4.6.1 exits zero on upload
  // errors. Propagate rejection and independently check the server's app state.
  const uploaded = await homey.devkit.runApp({ app: archive, env: {}, debug: false, clean: false });
  if (uploaded.appId !== manifest.id) throw Error('Homey did not acknowledge the expected app installation');
  const installed = await verifyInstalled({ version: manifest.version,
    getApp: () => homey.apps.getApp({ id: manifest.id, $cache: false }) });
  console.log(`Verified ${installed.id} ${installed.version}: running on ${homey.name}`);
  return installed;
}

async function main() {
  const api = require('homey/services/AthomApi');
  const homey = await api.getActiveHomey();
  await configureRoute(homey, process.env.HOMEY_INSTALL_URL);
  await installApp({ homey });
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
}
module.exports = { verifyInstalled, validateInstallUrl, configureRoute, installApp };
