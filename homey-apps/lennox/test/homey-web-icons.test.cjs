'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { PATCHES, EXPECTED_SHA256, transformSource, patchBundle, writePatchedBundle } = require('../scripts/patch-homey-13.5.3-web-icons.cjs');

// Small executable vendor-shaped fragments, not the proprietary vendor bundle.
// They preserve each reviewed original target and its surrounding branch logic.
const SOURCE = `
function brandOwner(r,t){let n={name:null,color:null,iconUrl:null};r!=null&&(n.iconUrl=\`https://icons-cdn.athom.com/\${r.iconObj?.id}.svg\`,n.name=r.name,n.color=r.color??\`#333333\`);t.appObj&&(n.name=t.appObj.name,n.color=t.appObj.brandColor,n.iconUrl=t.appObj.icon);return n}
function brandItem(s,key){return key===\`homey:manager:vdevice\`?{kind:'homey-logo'}:{children:(0,L.jsx)(B,{source:s.iconUrl,color:z.color.white,size:z.icon.size_large})}}
function installedAppInfo(i){return {appName:i.name,appIcon:\`https://icons-cdn.athom.com/\${i.iconObj?.id}.svg\`,appColor:i.brandColor??i.color}}
function driverHeader(e){return e.appInfo.appId===\`vdevice\`?{kind:'homey-logo'}:(0,L.jsx)(B,{source:e.appInfo?.appIcon,color:z.color.white,size:z.icon.size_large})}
function connectHeader(e){return e.appInfo.appId===\`vdevice\`?{kind:'homey-logo'}:(0,L.jsx)(B,{source:e.appInfo.appIcon,color:z.color.white,size:\`50px\`})}
function selectedDriver(n,u){let r={args:{}};if(u){let e=n?.iconObj?.id;r.args.driverInfo={driverName:n?.name,driverIcon:\`https://icons-cdn.athom.com/\${e}.svg\`};return r.args.driverInfo}return {driverName:n?.name,driverIcon:n?.icon}}
function selectedDriverTile(e){return (0,L.jsx)(qB,{isNoInteraction:!0,iconUrl:e.driverInfo.driverIcon,name:e.driverInfo.driverName})}
function virtualDriver(n){return {driverName:n.name,driverIcon:\`https://icons-cdn.athom.com/\${n.iconObj?.id}.svg\`}}
`;

function evaluate(source) {
  const context = vm.createContext({
    z: { color: { white: '#fff' }, icon: { size_large: '32px' } },
    L: { jsx: (component, props) => component(props) },
    B: props => ({ kind: 'url-glyph', ...props }),
    mF: props => ({ kind: 'shared-icon-loader', ...props }),
    qB: props => ({ kind: 'driver-tile', ...props }),
  });
  vm.runInContext(source, context);
  return context;
}

const plain = value => JSON.parse(JSON.stringify(value));
const icon = { id: 'custom-local-hash', url: '/api/icon/custom-local-hash' };

test('every patch target occurs once and transformed component source is valid JavaScript', () => {
  assert.equal(PATCHES.length, 9);
  for (const patch of PATCHES) assert.equal(SOURCE.split(patch.before).length - 1, 1, patch.name);
  const patched = transformSource(SOURCE);
  assert.doesNotThrow(() => evaluate(patched));
  for (const patch of PATCHES) assert.equal(patched.split(patch.after).length - 1, 1, patch.name);
});

test('installed brand items keep the complete icon object and use the local-capable shared loader', () => {
  const app = { name: 'Lennox', iconObj: icon, color: '#bd2025' };
  const before = evaluate(SOURCE);
  const oldOwner = before.brandOwner(app, {});
  assert.equal(before.brandItem(oldOwner).children.kind, 'url-glyph');
  assert.equal(before.brandItem(oldOwner).children.source, 'https://icons-cdn.athom.com/custom-local-hash.svg');
  const after = evaluate(transformSource(SOURCE));
  const owner = after.brandOwner(app, {});
  assert.deepEqual(plain(owner.iconObj), icon);
  assert.equal(owner.iconUrl, null);
  const rendered = after.brandItem(owner).children;
  assert.equal(rendered.kind, 'shared-icon-loader');
  assert.deepEqual(plain(rendered.iconObj), icon);
  assert.equal(rendered.color, '#fff');
  assert.equal(owner.color, '#bd2025');
});

test('App Store search results preserve their URL-only glyph and override installed icon metadata', () => {
  const after = evaluate(transformSource(SOURCE));
  const store = { name: 'Store app', brandColor: '#112233', icon: 'https://example.invalid/store.svg' };
  for (const installed of [null, { name: 'Installed', iconObj: icon }]) {
    const owner = after.brandOwner(installed, { appObj: store });
    assert.equal(owner.name, 'Store app');
    assert.equal(owner.color, '#112233');
    assert.equal(owner.iconObj, null);
    assert.equal(after.brandItem(owner).children.kind, 'url-glyph');
    assert.equal(after.brandItem(owner).children.source, store.icon);
  }
});

test('installed app headers use the shared loader on both driver and connect screens', () => {
  const after = evaluate(transformSource(SOURCE));
  const appInfo = after.installedAppInfo({ name: 'Lennox', iconObj: icon, brandColor: '#bd2025' });
  for (const render of [after.driverHeader, after.connectHeader]) {
    const rendered = render({ appInfo });
    assert.equal(rendered.kind, 'shared-icon-loader');
    assert.deepEqual(plain(rendered.iconObj), icon);
    assert.equal(rendered.color, '#fff');
  }
});

test('not-installed store app headers retain their original public URL behavior', () => {
  const after = evaluate(transformSource(SOURCE));
  const appInfo = { appId: 'store.app', appIcon: 'https://example.invalid/store.svg' };
  for (const render of [after.driverHeader, after.connectHeader]) {
    const rendered = render({ appInfo });
    assert.equal(rendered.kind, 'url-glyph');
    assert.equal(rendered.source, appInfo.appIcon);
  }
});

test('Homey virtual-device branding retains priority over all icon-object changes', () => {
  const after = evaluate(transformSource(SOURCE));
  assert.equal(after.brandItem({ iconObj: icon }, 'homey:manager:vdevice').kind, 'homey-logo');
  const appInfo = { appId: 'vdevice', appIconObj: icon, appIcon: null };
  assert.equal(after.driverHeader({ appInfo }).kind, 'homey-logo');
  assert.equal(after.connectHeader({ appInfo }).kind, 'homey-logo');
  assert.deepEqual(plain(after.virtualDriver({ name: 'Virtual', iconObj: icon })), plain(evaluate(SOURCE).virtualDriver({ name: 'Virtual', iconObj: icon })));
});

test('missing installed icon objects reach the shared fallback instead of an empty CDN glyph', () => {
  const after = evaluate(transformSource(SOURCE));
  const owner = after.brandOwner({ name: 'Missing icon' }, {});
  assert.equal(after.brandItem(owner).children.kind, 'shared-icon-loader');
  assert.equal(after.brandItem(owner).children.iconObj, null);
  const appInfo = after.installedAppInfo({ name: 'Missing icon' });
  assert.equal(after.driverHeader({ appInfo }).kind, 'shared-icon-loader');
  assert.equal(after.connectHeader({ appInfo }).kind, 'shared-icon-loader');
});

test('selected installed driver icons retain local fallback through the connect screen', () => {
  const after = evaluate(transformSource(SOURCE));
  const driverInfo = after.selectedDriver({ name: 'Thermostat', iconObj: icon }, true);
  const rendered = after.selectedDriverTile({ driverInfo });
  assert.equal(rendered.kind, 'driver-tile');
  assert.deepEqual(plain(rendered.iconObj), icon);
  assert.equal(rendered.iconUrl, null, 'A stale public URL must not take precedence over the icon object');
  assert.equal(rendered.isNoInteraction, true);
  const storeInfo = after.selectedDriver({ name: 'Store device', icon: 'https://example.invalid/driver.svg' }, false);
  const storeTile = after.selectedDriverTile({ driverInfo: storeInfo });
  assert.equal(storeTile.iconUrl, 'https://example.invalid/driver.svg');
  assert.equal(storeTile.iconObj, undefined);
});

test('missing, duplicate and already-patched targets are refused', () => {
  assert.throws(() => transformSource(SOURCE.replace(PATCHES[0].before, '')), /expected 1 original match, found 0/);
  assert.throws(() => transformSource(SOURCE + PATCHES[0].before), /expected 1 original match, found 2/);
  assert.throws(() => transformSource(transformSource(SOURCE)), /expected 1 original match, found 0/);
});

test('file-writing path rejects unreviewed bundles and never overwrites input or an existing output', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'homey-web-icon-guard-'));
  const input = path.join(directory, 'original.js');
  const output = path.join(directory, 'patched.js');
  fs.writeFileSync(input, SOURCE);
  assert.match(EXPECTED_SHA256, /^[a-f0-9]{64}$/);
  assert.throws(() => patchBundle(Buffer.from(SOURCE)), /Unsupported Homey bundle SHA256/);
  assert.throws(() => writePatchedBundle(input, output), /Unsupported Homey bundle SHA256/);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(input, 'utf8'), SOURCE);
  assert.throws(() => writePatchedBundle(input, input), /paths must differ/);
  fs.writeFileSync(output, 'keep existing output');
  assert.throws(() => writePatchedBundle(input, output), /Output already exists/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep existing output');
});

test('the reviewed vendor bundle patches without changing the shared loader or virtual-device path', {
  skip: process.env.HOMEY_REVIEWED_WEB_BUNDLE ? false : 'Set HOMEY_REVIEWED_WEB_BUNDLE to the exact reviewed vendor asset for integration verification',
}, () => {
  const input = fs.readFileSync(process.env.HOMEY_REVIEWED_WEB_BUNDLE);
  const { output, report } = patchBundle(input);
  assert.equal(report.replacements.length, 9);
  assert.notEqual(report.originalSha256, report.patchedSha256);
  const original = input.toString('utf8'), patched = output.toString('utf8');
  let reconstructed = patched;
  for (const patch of [...PATCHES].reverse()) reconstructed = reconstructed.replace(patch.after, patch.before);
  assert.equal(reconstructed, original, 'Only the nine reviewed substitutions may change vendor bytes');
  const originalLoader = original.slice(original.indexOf('function fpe('), original.indexOf('var mpe='));
  const patchedLoader = patched.slice(patched.indexOf('function fpe('), patched.indexOf('var mpe='));
  assert.ok(originalLoader.length > 1000);
  assert.equal(patchedLoader, originalLoader, 'The established auth/base URL/fetch/fallback implementation is reused unchanged');
  const virtual = 'driverInfo:{driverName:t?.name,driverIcon:`https://icons-cdn.athom.com/${n}.svg`},isInstalled:!0,appInfo:{appId:`vdevice`';
  assert.equal(original.split(virtual).length - 1, 1);
  assert.equal(patched.split(virtual).length - 1, 1);
});
