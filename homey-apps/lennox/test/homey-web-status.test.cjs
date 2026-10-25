'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CHANGES, DRIVER, transformSource } = require('../scripts/patch-homey-13.5.3-status.cjs');
const { patchBundle } = require('../scripts/patch-homey-13.5.3-controls.cjs');
const buttons = require('../scripts/patch-homey-13.5.3-thermostat-buttons.cjs');
const selection = require('../scripts/patch-homey-13.5.3-thermostat.cjs');
const icons = require('../scripts/patch-homey-13.5.3-web-icons.cjs');
const bundle = process.env.HOMEY_REVIEWED_WEB_BUNDLE;
const optional = { skip: !bundle && 'Set HOMEY_REVIEWED_WEB_BUNDLE to execute reviewed vendor source' };
function segment(source, before, after) {
  const start = source.indexOf(before);
  assert.ok(start >= 0, before);
  const end = source.indexOf(after, start + before.length);
  assert.ok(end >= 0, after);
  return source.slice(start + before.length, end);
}
function reviewed() {
  const original = fs.readFileSync(bundle);
  return selection.patchBundle(icons.patchBundle(original).output).output;
}
function device(overrides = {}) {
  return { id: 'device', driverId: DRIVER, class: 'thermostat', uiIndicator: null,
    capabilitiesObj: Object.fromEntries([
      ['measure_temperature', 'number', 23.5], ['measure_humidity', 'number', 45],
      ['measure_temperature.heat', 'number', 23.5], ['target_temperature.heat', 'number', 22],
      ['hvac_state', 'enum', 'idle'], ['thermostat_mode', 'enum', 'heat'],
      ['heat_increase', 'boolean', undefined],
    ].map(([id, type, value]) => [id, { id, type, value, title: id }])), ...overrides };
}
test('status transform refuses missing, duplicate and already patched fragments', () => {
  const source = CHANGES.map(([before]) => before).join(';');
  assert.equal(transformSource(source), CHANGES.map(([,after]) => after).join(';'));
  assert.throws(() => transformSource(''), /found 0/);
  assert.throws(() => transformSource(source + source), /found 2/);
  assert.throws(() => transformSource(transformSource(source)), /found 0/);
});
test('reviewed settings source offers stable Lennox indicators, preserves saved choice and leaves other thermostat restrictions intact', optional, () => {
  const source = patchBundle(reviewed()).output.toString();
  const select = segment(source, 'l=(0,P.useMemo)(()=>{let e=[],t=n?.capabilitiesObj', '),{statusIndicatorOptions:');
  // Include the opening fragment and remove useMemo dependency arguments.
  const selectableBody = 'let e=[],t=n?.capabilitiesObj' + select.slice(0, select.lastIndexOf('},[r,n?.capabilitiesObj]'));
  const optionsBody = segment(source, '{statusIndicatorOptions:u,statusIndicatorDefaultValue:d}=(0,P.useMemo)(()=>{', '},[n,l])');
  const jsx = (type, props) => ({ type, props });
  const SI = { Capability: { isInstanceOfId: (id, base) => id === base || id.startsWith(base + '.') } };
  const r = { messageFormatter: value => value };
  const selectable = Function('n', 'r', 'EW', 'DW', 'SI', selectableBody);
  const options = Function('n', 'l', 'L', 'pW', '_W', 'dW', 'cW', 'xW', 'qB', optionsBody);
  const d = device();
  const choices = selectable(d, r, [], ['measure_temperature','measure_humidity'], SI);
  assert.deepEqual(choices.map(item => item.id), ['measure_temperature','measure_humidity','hvac_state','.none']);
  const getOptions = dev => options(dev, selectable(dev,r,[],['measure_temperature','measure_humidity'],SI), {jsx}, 'battery','number','alarm','alarms','string', {size:{medium:'medium'}});
  assert.deepEqual(getOptions(d).statusIndicatorOptions.map(item => item.key), choices.map(item => item.id));
  assert.equal(getOptions(d).statusIndicatorDefaultValue, 'measure_temperature');
  for (const id of ['measure_humidity','hvac_state','.none']) assert.equal(getOptions({...d,uiIndicator:id}).statusIndicatorDefaultValue,id);
  assert.deepEqual(getOptions({...d,driverId:'homey:app:other:thermostat'}).statusIndicatorOptions, []);
});
test('reviewed tile renderer respects Lennox choices, none and default while retaining other thermostat and danger-alarm rendering', optional, () => {
  const source = patchBundle(reviewed()).output.toString();
  const body = segment(source, 'function OW({device:e,tileSize:t}){', '}function dTe(');
  const components = ['Uwe','qwe','nTe','aTe','xW','pW','_W','dW','cW'];
  const renderer = Function('P','L','mTe','gTe','hTe','pTe','dTe','fTe', ...components, 'return function({device:e,tileSize:t}){' + body + '}')(
    {useMemo: fn=>fn()}, {jsx:(type,props)=>({type,props})}, d=>d.class,
    ({capabilitiesObj})=>({dangerCapabilityIds:[],isDangerAlarm:capabilitiesObj.alarm_fire?.value===true}), ()=> 'measure_temperature',
    ()=>false, id=>id.startsWith('measure_')||id.startsWith('target_'), ()=>false, ...components);
  const d = device();
  assert.equal(renderer({device:d}).type, 'aTe');
  for (const [id,type] of [['measure_temperature','_W'],['measure_humidity','_W'],['hvac_state','xW']]) {
    const result = renderer({device:{...d,uiIndicator:id}});
    assert.equal(result.type,type); assert.equal(result.props.capabilityId,id);
  }
  assert.equal(renderer({device:{...d,uiIndicator:'.none'}}),null);
  assert.equal(renderer({device:{...d,driverId:'other',uiIndicator:'measure_humidity'}}).type,'aTe');
  assert.equal(renderer({device:{...d,uiIndicator:'hvac_state',capabilitiesObj:{...d.capabilitiesObj,alarm_fire:{value:true}}}}).type,'cW');
});
test('combined controls layer is syntax checked and exactly reversible to the deployed selection layer', optional, () => {
  const input = reviewed(), result = patchBundle(input);
  let reverted = result.output.toString();
  for(const [before,after] of [...CHANGES].reverse()) reverted = reverted.replace(after,before);
  reverted = reverted.replace(buttons.AFTER,buttons.BEFORE).replace(buttons.HOOK_AFTER,buttons.HOOK_BEFORE);
  assert.deepEqual(Buffer.from(reverted),input);
  assert.throws(()=>patchBundle(result.output),/Unsupported Homey/);
  assert.throws(()=>patchBundle(Buffer.from('unknown')),/Unsupported Homey/);
});
