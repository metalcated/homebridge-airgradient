'use strict';

// Exercise the CLI's real persistent-install packaging path. The fake devkit
// consumes the archive instead of contacting a Homey or using authentication.
const path = require('node:path');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { installApp } = require('./install-app.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
  let checked = false;
  const fs = require('node:fs');
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert(!/CMD.*--skip-build/.test(dockerfile), 'Installer must preprocess production dependencies');
  assert(dockerfile.includes('scripts/install-app.cjs'), 'Installer must verify upload and running state');
  await installApp({ root, homey: {
    platform: 'local', name: 'Packaging verification', baseUrl: 'http://127.0.0.1',
    apps: { async getApp() { return { id: 'com.metalcated.lennox', version: '0.1.0', state: 'running', enabled: true }; } },
    devkit: { async runApp({ app: stream, clean, debug }) {
      assert.equal(clean, false); assert.equal(debug, false);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const archive = gunzipSync(Buffer.concat(chunks));
      const files = [];
      for (let offset = 0; offset + 512 <= archive.length;) {
        const header = archive.subarray(offset, offset + 512);
        const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
        if (!name) break;
        const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
        const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
        files.push(prefix ? `${prefix}/${name}` : name);
        offset += 512 + Math.ceil(size / 512) * 512;
      }
      const normalized = files.map(file => file.replace(/^\.\//, ''));
      assert(normalized.includes('app.json') && normalized.includes('lib/session.js'));
      assert(normalized.some(file => file.startsWith('node_modules/lennoxapi/')));
      assert(normalized.includes('node_modules/undici/index.js'));
      assert(!normalized.some(file => /^(test|scripts|\.homeybuild)\//.test(file)));
      assert(!normalized.some(file => /^node_modules\/(sharp|homey-api|inquirer|dockerode)\//.test(file)));
      assert(!normalized.includes('node_modules/homey/bin/homey.mjs'));
      assert(archive.length < 5 * 1024 * 1024, 'Install archive must contain runtime dependencies only');
      assert(normalized.length < 500, 'Development tool files leaked into the install archive');
      console.log(`Verified actual installation archive: ${normalized.length} entries, ${archive.length} bytes unpacked`);
      checked = true;
      return { appId: 'com.metalcated.lennox' };
    } },
  } });
  assert(checked, 'The installer must reach the devkit with its prepared archive');
  await assert.rejects(installApp({ root, homey: {
    name: 'Rejected upload verification',
    devkit: { async runApp({ app: stream }) { stream.destroy(); throw Error('Intentional upload rejection'); } },
    apps: { getApp() { assert.fail('An existing app must not mask an upload rejection'); } },
  } }), /Intentional upload rejection/);
  console.log('Upload rejection propagates as failure before runtime verification');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
