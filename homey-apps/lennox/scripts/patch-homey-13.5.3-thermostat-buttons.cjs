#!/usr/bin/env node
'use strict';

// Optional local presentation patch. This layer requires the exact reviewed
// Homey 13.5.3 web bundle with the icon and thermostat-selection fixes applied.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const EXPECTED_SHA256 = '5fddde7f128abfe1d23dfca4ebae3baa815995959fd14166c988c43684d54215';
const DRIVER_ID = 'homey:app:com.metalcated.lennox:thermostat';
const BEFORE = "function VSe(e){let{device:t}=WN({deviceId:e.deviceId}),n=(0,P.useMemo)(()=>{let t={};for(let n of e.component.capabilities){let e=n.startsWith(`target_temperature`),[,r]=n.split(`.`);t[r]??(t[r]=n),e&&t[r]!=null&&(t[r]=n)}return Object.values(t)},[e.component.capabilities]),[requestedCapability,i]=(0,P.useState)(()=>n[0]),r=n.includes(requestedCapability)?requestedCapability:n[0],a=[];if(r!=null){let[,e]=r.split(`.`);a=e===void 0?[`target_temperature`,`measure_temperature`,`thermostat_mode`]:[`target_temperature.${e}`,`measure_temperature.${e}`,`thermostat_mode.${e}`]}let o=t?.capabilitiesObj?.[a[0]]??null,s=t?.capabilitiesObj?.[a[1]]??null,c=t?.capabilitiesObj?.[a[2]]??null,[l,u,d]=pR({deviceId:e.deviceId,capabilityId:o?.id??null}),[f,,p]=pR({deviceId:e.deviceId,capabilityId:s?.id??null}),[m,,]=pR({deviceId:e.deviceId,capabilityId:c?.id??null}),h=(0,P.useMemo)(()=>(0,KI.default)(function(e){u(e).then(()=>{}).catch(e=>{})},1e3),[u]);return(0,L.jsxs)(uR,{children:[(0,L.jsx)(fR,{children:n.length>1&&(0,L.jsx)(lR,{selectedCapabilityId:r,componentCapabilities:n,capabilitiesObj:t?.capabilitiesObj,onSelectionChange:i})}),(0,L.jsx)(dR,{children:(0,L.jsx)(PSe,{min:d?.min??0,max:d?.max??40,step:d?.step??.5,units:d?.units??null,targetValue:l,targetValueDecimals:d?.decimals,measureValue:f,measureValueDecimals:p?.decimals,hideMeasureTemperature:s==null,modeValue:m,onTargetValueChange:h})})]})}";
const AFTER = [
  "var LennoxThermostatDial1353=R('div',{target:'lennox-thermostat-dial-1353'})(`display:flex;flex:0 1 auto;align-items:center;justify-content:center;min-width:0;min-height:0;width:100%;aspect-ratio:1;max-height:calc(100% - 48px);&>svg{display:block;width:100%;height:100%;max-height:100%;}`);",
  "function VSe(e){let{device:t}=WN({deviceId:e.deviceId}),n=(0,P.useMemo)(()=>{let t={};for(let n of e.component.capabilities){let e=n.startsWith(`target_temperature`),[,r]=n.split(`.`);t[r]??(t[r]=n),e&&t[r]!=null&&(t[r]=n)}return Object.values(t)},[e.component.capabilities]),[requestedCapability,i]=(0,P.useState)(()=>n[0]),r=n.includes(requestedCapability)?requestedCapability:n[0],a=[];if(r!=null){let[,e]=r.split(`.`);a=e===void 0?[`target_temperature`,`measure_temperature`,`thermostat_mode`]:[`target_temperature.${e}`,`measure_temperature.${e}`,`thermostat_mode.${e}`]}let o=t?.capabilitiesObj?.[a[0]]??null,s=t?.capabilitiesObj?.[a[1]]??null,c=t?.capabilitiesObj?.[a[2]]??null,[l,u,d]=pR({deviceId:e.deviceId,capabilityId:o?.id??null,requestTimeout:t?.driverId==='homey:app:com.metalcated.lennox:thermostat'?45000:void 0}),[f,,p]=pR({deviceId:e.deviceId,capabilityId:s?.id??null}),[m,,]=pR({deviceId:e.deviceId,capabilityId:c?.id??null}),h=(0,P.useMemo)(()=>(0,KI.default)(function(e){u(e).then(()=>{}).catch(e=>{})},1e3),[u]);",
  "const lennoxDevice=t?.driverId==='homey:app:com.metalcated.lennox:thermostat';",
  "const [mainMode]=pR({deviceId:e.deviceId,capabilityId:lennoxDevice?'thermostat_mode':null});",
  "const adjustmentType=r==='target_temperature.heat'?'heat':r==='target_temperature.cool'?'cool':r==='target_temperature'?'target':null;",
  "const activeMode=adjustmentType==='heat'?(mainMode==='heat'||mainMode==='auto'):adjustmentType==='cool'?(mainMode==='cool'||mainMode==='auto'):adjustmentType==='target'?['heat','cool','auto'].includes(mainMode):false;",
  "const adjustmentPrefix=lennoxDevice&&activeMode&&o!=null?adjustmentType:null;",
  "const [,decreaseWriter,decreaseCapability]=pR({deviceId:e.deviceId,capabilityId:adjustmentPrefix==null?null:adjustmentPrefix+'_decrease',requestTimeout:45000});",
  "const [,increaseWriter,increaseCapability]=pR({deviceId:e.deviceId,capabilityId:adjustmentPrefix==null?null:adjustmentPrefix+'_increase',requestTimeout:45000});",
  "const adjustmentPending=(0,P.useRef)(false);",
  "const [isAdjustmentPending,setAdjustmentPending]=(0,P.useState)(false);",
  "const showAdjustments=adjustmentPrefix!=null&&decreaseCapability!=null&&increaseCapability!=null;",
  "const cannotAdjust=isAdjustmentPending||t?.available!==true||t?.settings?.read_only!==false||o?.setable===false||!Number.isFinite(l);",
  "const decreaseDisabled=cannotAdjust||decreaseCapability?.setable!==true||(Number.isFinite(d?.min)&&l<=d.min);",
  "const increaseDisabled=cannotAdjust||increaseCapability?.setable!==true||(Number.isFinite(d?.max)&&l>=d.max);",
  "function pressAdjustment(event,writer,disabled){",
  "  event.stopPropagation();",
  "  if(disabled||adjustmentPending.current)return;",
  "  adjustmentPending.current=true;",
  "  setAdjustmentPending(true);",
  "  Promise.resolve().then(()=>writer(true)).catch(()=>{}).finally(()=>{",
  "    adjustmentPending.current=false;",
  "    setAdjustmentPending(false);",
  "  });",
  "}",
  "function adjustmentButton(direction,writer,disabled){",
  "  const verb=direction<0?'Decrease':'Increase';",
  "  const name=adjustmentType==='heat'?'heating temperature':adjustmentType==='cool'?'cooling temperature':'target temperature';",
  "  const label=verb+' '+name;",
  "  return (0,L.jsx)('button',{",
  "    type:'button','aria-label':label,title:label,disabled,",
  "    style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:44,height:44,flex:'0 0 44px',padding:5,border:0,borderRadius:'50%',background:'transparent',color:'white',font:'inherit',cursor:disabled?'not-allowed':'pointer',opacity:disabled?0.4:1},",
  "    onPointerDown:event=>event.stopPropagation(),",
  "    onClick:event=>pressAdjustment(event,writer,disabled),",
  "    children:(0,L.jsx)('span',{'aria-hidden':true,style:{display:'inline-flex',alignItems:'center',justifyContent:'center',width:34,height:34,boxSizing:'border-box',border:'1px solid rgba(255,255,255,0.7)',borderRadius:'50%',background:'rgba(255,255,255,0.08)',fontSize:26,lineHeight:1},children:direction<0?'−':'+'})",
  "  });",
  "}",
  "const radial=(0,L.jsx)(PSe,{min:d?.min??0,max:d?.max??40,step:d?.step??.5,units:d?.units??null,targetValue:l,targetValueDecimals:d?.decimals,measureValue:f,measureValueDecimals:p?.decimals,hideMeasureTemperature:s==null,modeValue:m,onTargetValueChange:h});",
  "const action=showAdjustments?(0,L.jsxs)(dR,{children:[",
  "  (0,L.jsx)(LennoxThermostatDial1353,{children:radial}),",
  "  (0,L.jsxs)('div',{role:'group','aria-label':'Temperature adjustment','aria-busy':isAdjustmentPending,style:{display:'flex',alignItems:'center',justifyContent:'center',gap:12,flex:'0 0 48px',height:48,width:'100%',paddingBottom:4,boxSizing:'border-box'},children:[adjustmentButton(-1,decreaseWriter,decreaseDisabled),adjustmentButton(1,increaseWriter,increaseDisabled)]})",
  "]}):(0,L.jsx)(dR,{children:radial});",
  "return(0,L.jsxs)(uR,{children:[(0,L.jsx)(fR,{children:n.length>1&&(0,L.jsx)(lR,{selectedCapabilityId:r,componentCapabilities:n,capabilitiesObj:t?.capabilitiesObj,onSelectionChange:i})}),action]});",
  "}"
].join("\n");

const HOOK_BEFORE = "function pR({deviceId:e,capabilityId:t}){let n=(0,P.useRef)(void 0),r=(0,P.useRef)(null),{deviceInstance:i,device:a}=WN({deviceId:e}),o=t==null?null:a?.capabilitiesObj?.[t]??null,[s,c]=(0,P.useState)(o?.value??null);return(0,P.useEffect)(()=>{c(o?.value??null)},[o]),(0,P.useEffect)(()=>{if(o?.id==null||i==null)return;let e=i?.makeCapabilityInstance(o.id,e=>{c(e)});return r.current=e,function(){e?.destroy()}},[i,o?.id]),[s,WE((e,t)=>{if(o==null)return Promise.reject(Error(`Capability object is not available`));let i=o.getable===!0;if(o.setable===!1)return Promise.reject(Error(`Capability ${o.id} is not setable`));let a=s;if(i===!0&&c(e),t?.local===!0)return Promise.resolve();let l=r.current?.setValue(e)??Promise.reject(Error(`Capability instance not available`));return n.current=l,l.then(e=>{}).catch(e=>{q.handleError(e),n.current===l&&i===!0&&c(a)}).finally(()=>{n.current===l&&(n.current=void 0)}),l}),o]}";
const HOOK_AFTER = "function pR({deviceId:e,capabilityId:t,requestTimeout:lennoxRequestTimeout}){let n=(0,P.useRef)(void 0),r=(0,P.useRef)(null),{deviceInstance:i,device:a}=WN({deviceId:e}),o=t==null?null:a?.capabilitiesObj?.[t]??null,[s,c]=(0,P.useState)(o?.value??null),lennoxDeviceInstance=i,lennoxDeviceSnapshot=a;return(0,P.useEffect)(()=>{c(o?.value??null)},[o]),(0,P.useEffect)(()=>{if(o?.id==null||i==null)return;let e=i?.makeCapabilityInstance(o.id,e=>{c(e)});return r.current=e,function(){e?.destroy()}},[i,o?.id]),[s,WE((e,t)=>{if(o==null)return Promise.reject(Error(`Capability object is not available`));let i=o.getable===!0;if(o.setable===!1)return Promise.reject(Error(`Capability ${o.id} is not setable`));let a=s;if(i===!0&&c(e),t?.local===!0)return Promise.resolve();let l=lennoxRequestTimeout===45000&&lennoxDeviceSnapshot?.driverId===`homey:app:com.metalcated.lennox:thermostat`&&[`target_temperature`,`target_temperature.heat`,`target_temperature.cool`,`heat_decrease`,`heat_increase`,`cool_decrease`,`cool_increase`,`target_decrease`,`target_increase`].includes(o.id)?(lennoxDeviceInstance?.manager?.setCapabilityValue?.({deviceId:lennoxDeviceInstance.id,capabilityId:o.id,value:e,$timeout:lennoxRequestTimeout})??Promise.reject(Error(`Device manager not available`))):(r.current?.setValue(e)??Promise.reject(Error(`Capability instance not available`)));return n.current=l,l.then(e=>{}).catch(e=>{q.handleError(e),n.current===l&&i===!0&&c(a)}).finally(()=>{n.current===l&&(n.current=void 0)}),l}),o]}";

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// Pure fragment transformation permits a separately reviewed presentation layer
// to compose this change. Only patchBundle accepts whole vendor bundle bytes.
function transformSource(source) {
  if (typeof source !== 'string') throw Error('Expected JavaScript source text');
  for (const [name, before] of [['thermostat renderer', BEFORE], ['capability writer', HOOK_BEFORE]]) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw Error(`Expected one reviewed ${name} fragment; found ${count}`);
  }
  return source.replace(BEFORE, AFTER).replace(HOOK_BEFORE, HOOK_AFTER);
}

function patchBundle(input) {
  if (!Buffer.isBuffer(input)) throw Error('Expected the reviewed bundle as a Buffer');
  if (sha256(input) !== EXPECTED_SHA256) throw Error('Unsupported Homey bundle; the reviewed icon and thermostat-selection fixes must already be applied');
  const output = Buffer.from(transformSource(input.toString('utf8')));
  const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: output, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw Error(`Patched JavaScript failed syntax validation: ${checked.stderr.trim()}`);
  return { output, report: { homeyVersion: '13.5.3', originalSha256: sha256(input), patchedSha256: sha256(output), replacements: 2, driverId: DRIVER_ID } };
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
    if (process.argv.length !== 4) throw Error('Usage: node patch-homey-13.5.3-thermostat-buttons.cjs SELECTION_PATCHED.js OUTPUT.js');
    process.stdout.write(JSON.stringify(writePatchedBundle(process.argv[2], process.argv[3]), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { EXPECTED_SHA256, DRIVER_ID, BEFORE, AFTER, HOOK_BEFORE, HOOK_AFTER, transformSource, patchBundle, writePatchedBundle };
