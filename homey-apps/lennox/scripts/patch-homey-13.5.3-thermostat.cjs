#!/usr/bin/env node
'use strict';

// Optional vendor presentation workaround, prepared separately from the app.
// Accept only the exact reviewed bundle with the existing icon fix applied.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const EXPECTED_SHA256 = '40f1549b15cbdc1868df7d867f2596d3b4f773511424f19bbfccc8238be416db';
const BEFORE = '[r,i]=(0,P.useState)(()=>n[0]),a=[];';
const AFTER = '[requestedCapability,i]=(0,P.useState)(()=>n[0]),r=n.includes(requestedCapability)?requestedCapability:n[0],a=[];';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  const count = source.split(BEFORE).length - 1;
  if (count !== 1) throw Error(`Expected one reviewed thermostat selection fragment; found ${count}`);
  return source.replace(BEFORE, AFTER);
}

function patchBundle(input) {
  if (!Buffer.isBuffer(input)) throw Error('Expected the reviewed bundle as a Buffer');
  if (sha256(input) !== EXPECTED_SHA256) throw Error('Unsupported Homey bundle; the reviewed icon workaround must already be applied');
  const output = Buffer.from(transformSource(input.toString('utf8')));
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: output, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw Error(`Patched JavaScript failed syntax validation: ${checked.stderr.trim()}`);
  return { output, report: { homeyVersion: '13.5.3', originalSha256: sha256(input), patchedSha256: sha256(output), replacements: 1 } };
}

function writePatchedBundle(inputPath, outputPath) {
  if (!inputPath || !outputPath) throw Error('Expected separate input and output paths');
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw Error('The input must remain untouched');
  if (fs.existsSync(outputPath)) throw Error('Output already exists');
  const { output, report } = patchBundle(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, output, { flag: 'wx', mode: 0o644 });
  return report;
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-thermostat.cjs ICON_PATCHED.js OUTPUT.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { EXPECTED_SHA256, BEFORE, AFTER, transformSource, patchBundle, writePatchedBundle };
