const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { emulator } = require('./emulator.cjs');

// This starts the actual Homebridge executable, bridge and plugin manager in an
// isolated storage directory. It never pairs to an Apple account or user's bridge.
test('actual Homebridge process boots, polls, stops and restores its persisted accessory cache', async t => {
  const device = await emulator('v1'); t.after(device.close);
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'airgradient-real-bridge-'));
  const root = path.dirname(path.dirname(require.resolve('homebridge')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.homebridge;
  fs.writeFileSync(path.join(storage, 'config.json'), JSON.stringify({ bridge: { name: 'AirGradient Emulator QA',
    username: '0E:22:33:44:55:66', port: 51887, pin: '031-45-154' }, platforms: [{ platform: 'AirGradientPlatform',
    sensors: [{ ...device.settings, pollingInterval: 1000 }] }] }));
  const boot = async () => {
    const child = spawn(process.execPath, [path.join(root, bin), '-U', storage, '-P', path.resolve(__dirname, '..'), '--strict-plugin-resolution', '-D'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let ended = false;
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.on('exit', () => ended = true);
    t.after(() => { if (!ended) { child.kill('SIGTERM'); } });
    const until = Date.now() + 7000;
    while (!output.includes('Updated characteristics')) {
      if (ended || Date.now() > until) { child.kill('SIGTERM'); throw Error(`Bridge startup failed: ${output}`); }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert(output.includes('@metalcated/homebridge-airgradient'));
    assert(!output.includes('ERROR LOADING PLUGIN')); assert(!output.includes('ERROR INITIALIZING PLUGIN'));
    const stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Bridge shutdown timed out')); }, 7000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    child.kill('SIGTERM'); const code = await stopped;
    // Homebridge 1.x deliberately exits 128 + SIGTERM after graceful teardown.
    assert([0, 143].includes(code), `Unexpected exit ${code}: ${output}`);
    assert.match(output, /shutting down Homebridge/i);
    return output;
  };
  await boot();
  const cache = fs.readdirSync(path.join(storage, 'accessories')).find(name => name === 'cachedAccessories');
  assert(cache); const saved = JSON.parse(fs.readFileSync(path.join(storage, 'accessories', cache), 'utf8'));
  assert.equal(saved.length, 1); assert.equal(saved[0].context.serial, 'abc123');
  const second = await boot(); assert.match(second, /Restoring existing accessory from cache/);
});
