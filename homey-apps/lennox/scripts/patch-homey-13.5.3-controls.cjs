#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const buttons = require('./patch-homey-13.5.3-thermostat-buttons.cjs');
const status = require('./patch-homey-13.5.3-status.cjs');
const EXPECTED_SHA256 = '5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function patchBundle(input) {
  if (!Buffer.isBuffer(input) || sha256(input) !== EXPECTED_SHA256) throw Error('Unsupported Homey bundle; reviewed icon and thermostat selection patches are required');
  const output = Buffer.from(status.transformSource(buttons.transformSource(input.toString('utf8'))));
  const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: output, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (check.error) throw check.error;
  if (check.status !== 0) throw Error(`Patched JavaScript failed syntax validation: ${check.stderr.trim()}`);
  return { output, report: { homeyVersion: '13.5.3', originalSha256: sha256(input), patchedSha256: sha256(output) } };
}

function writePatchedBundle(inputPath, outputPath) {
  if (!inputPath || !outputPath || path.resolve(inputPath) === path.resolve(outputPath)) throw Error('Expected separate input and output paths');
  if (fs.existsSync(outputPath)) throw Error('Output already exists');
  const { output, report } = patchBundle(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, output, { flag: 'wx', mode: 0o644 });
  return report;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-controls.cjs SELECTION_PATCHED.js OUTPUT.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { EXPECTED_SHA256, patchBundle, writePatchedBundle };
