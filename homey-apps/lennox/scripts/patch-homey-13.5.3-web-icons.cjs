#!/usr/bin/env node
'use strict';

// Local Homey Web App workaround. This patches presentation only and deliberately
// accepts one reviewed vendor build. It never deploys or overwrites its input.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HOMEY_VERSION = '13.5.3';
const EXPECTED_SHA256 = 'f0f78b5c8de6ee86acaf75d14a551479aff9733e63005b68817bdb323789c717';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const PATCHES = Object.freeze([
  {
    name: 'preserve-brand-icon-object',
    before: 'let n={name:null,color:null,iconUrl:null};',
    after: 'let n={name:null,color:null,iconUrl:null,iconObj:null};',
  },
  {
    name: 'installed-brand-local-icon',
    before: 'n.iconUrl=`https://icons-cdn.athom.com/${r.iconObj?.id}.svg`,n.name=r.name',
    after: 'n.iconObj=r.iconObj??null,n.iconUrl=null,n.name=r.name',
  },
  {
    name: 'preserve-app-store-url-icons',
    before: 'n.name=t.appObj.name,n.color=t.appObj.brandColor,n.iconUrl=t.appObj.icon',
    after: 'n.name=t.appObj.name,n.color=t.appObj.brandColor,n.iconObj=null,n.iconUrl=t.appObj.icon',
  },
  {
    name: 'brand-item-shared-loader',
    before: 'children:(0,L.jsx)(B,{source:s.iconUrl,color:z.color.white,size:z.icon.size_large})',
    after: 'children:(s.iconObj!=null||s.iconUrl==null?(0,L.jsx)(mF,{iconObj:s.iconObj,color:z.color.white,size:z.icon.size_large}):(0,L.jsx)(B,{source:s.iconUrl,color:z.color.white,size:z.icon.size_large}))',
  },
  {
    name: 'installed-app-header-icon-object',
    before: 'appName:i.name,appIcon:`https://icons-cdn.athom.com/${i.iconObj?.id}.svg`,appColor:',
    after: 'appName:i.name,appIconObj:i.iconObj??null,appIcon:null,appColor:',
  },
  {
    name: 'driver-list-app-header-shared-loader',
    before: '(0,L.jsx)(B,{source:e.appInfo?.appIcon,color:z.color.white,size:z.icon.size_large})',
    after: '(e.appInfo?.appIconObj!==void 0?(0,L.jsx)(mF,{iconObj:e.appInfo.appIconObj,color:z.color.white,size:z.icon.size_large}):(0,L.jsx)(B,{source:e.appInfo?.appIcon,color:z.color.white,size:z.icon.size_large}))',
  },
  {
    name: 'connect-app-header-shared-loader',
    before: '(0,L.jsx)(B,{source:e.appInfo.appIcon,color:z.color.white,size:`50px`})',
    after: '(e.appInfo.appIconObj!==void 0?(0,L.jsx)(mF,{iconObj:e.appInfo.appIconObj,color:z.color.white,size:`50px`}):(0,L.jsx)(B,{source:e.appInfo.appIcon,color:z.color.white,size:`50px`}))',
  },
  {
    name: 'installed-selected-driver-icon-object',
    before: 'let e=n?.iconObj?.id;r.args.driverInfo={driverName:n?.name,driverIcon:`https://icons-cdn.athom.com/${e}.svg`}',
    after: 'r.args.driverInfo={driverName:n?.name,driverIconObj:n?.iconObj??null,driverIcon:null}',
  },
  {
    name: 'connect-selected-driver-shared-loader',
    before: '(0,L.jsx)(qB,{isNoInteraction:!0,iconUrl:e.driverInfo.driverIcon,name:e.driverInfo.driverName})',
    after: '(0,L.jsx)(qB,{isNoInteraction:!0,iconObj:e.driverInfo.driverIconObj,iconUrl:e.driverInfo.driverIcon,name:e.driverInfo.driverName})',
  },
].map(value => Object.freeze(value)));

// Pure transformation is exported for portable component regression tests.
// The file-writing entry point always calls patchBundle() and checks the hash.
function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  for (const patch of PATCHES) {
    const matches = source.split(patch.before).length - 1;
    if (matches !== 1) throw Error(`Refusing ${patch.name}: expected 1 original match, found ${matches}`);
    source = source.replace(patch.before, patch.after);
  }
  return source;
}

function patchBundle(input) {
  if (!Buffer.isBuffer(input)) throw Error('Expected the original bundle as a Buffer');
  const actual = sha256(input);
  if (actual !== EXPECTED_SHA256) throw Error(`Unsupported Homey bundle SHA256: ${actual}. Expected ${EXPECTED_SHA256}; no output was written.`);
  const output = Buffer.from(transformSource(input.toString('utf8')), 'utf8');
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: output, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw Error(`Patched JavaScript failed syntax validation: ${checked.stderr.trim()}`);
  return { output, report: { homeyVersion: HOMEY_VERSION, originalSha256: actual,
    patchedSha256: sha256(output), originalBytes: input.length, patchedBytes: output.length,
    replacements: PATCHES.map(patch => ({ name: patch.name, matches: 1 })) } };
}

function writePatchedBundle(inputPath, outputPath) {
  if (!inputPath || !outputPath) throw Error('Usage: node patch-homey-13.5.3-web-icons.cjs ORIGINAL.js PATCHED.js');
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw Error('Input and output paths must differ; the original must remain untouched');
  // Check existence first for a useful error, then use wx to guard against races.
  if (fs.existsSync(outputPath)) throw Error('Output already exists; choose a new output file');
  const { output, report } = patchBundle(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath, output, { flag: 'wx', mode: 0o644 });
  return { ...report, inputPath: path.resolve(inputPath), outputPath: path.resolve(outputPath) };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-web-icons.cjs ORIGINAL.js PATCHED.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { HOMEY_VERSION, EXPECTED_SHA256, PATCHES, transformSource, patchBundle, writePatchedBundle };
