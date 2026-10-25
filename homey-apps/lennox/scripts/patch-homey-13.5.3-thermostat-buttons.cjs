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

const COALESCED_EXPECTED_SHA256 = '307892c8449d2445968b7b9c3c239b590e023a62a20fded4853c8c8af85ed522';
function replaceReviewed(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw Error(`Expected one reviewed coalescing fragment; found ${count}`);
  return source.replace(before, after);
}
function buildCoalescedRenderer() {
  const start = AFTER.indexOf('const adjustmentPending=');
  const end = AFTER.indexOf('function adjustmentButton(', start);
  if (start < 0 || end < start) throw Error('The reviewed adjustment handlers changed');
  const scheduler = String.raw`const adjustmentScheduler=(0,P.useRef)({active:null,relative:{steps:0,timer:null,ready:false,context:null},absolute:null});
const adjustmentMounted=(0,P.useRef)(true);
const adjustmentLive=(0,P.useRef)(null);
const [isAdjustmentPending,setAdjustmentPending]=(0,P.useState)(false);
const [queuedSteps,setQueuedSteps]=(0,P.useState)(0);
const [hasPendingAbsolute,setPendingAbsolute]=(0,P.useState)(false);
const showAdjustments=adjustmentPrefix!=null&&decreaseCapability!=null&&increaseCapability!=null;
const displayStep=Number.isFinite(d?.step)&&d.step>0?d.step:0.5;
const adjustmentContext=JSON.stringify([e.deviceId,r,mainMode,t?.settings?.temperature_control_units??'imperial',d?.units,displayStep,t?.available===true,t?.settings?.read_only===false]);
const canWriteAbsolute=lennoxDevice&&o!=null&&o.setable!==false&&t?.available===true&&t?.settings?.read_only===false&&Number.isFinite(l);
const canAdjust=showAdjustments&&canWriteAbsolute;
adjustmentLive.current={context:adjustmentContext,canAdjust,canWriteAbsolute,decreaseWriter,increaseWriter,decreaseCapability,increaseCapability,value:l,min:d?.min,max:d?.max,step:displayStep,units:d?.units??'',type:adjustmentType};
function cancelUnsentAdjustments(){
  const scheduler=adjustmentScheduler.current;
  clearTimeout(scheduler.relative.timer);
  scheduler.relative={steps:0,timer:null,ready:false,context:null};
  if(scheduler.absolute)clearTimeout(scheduler.absolute.timer);
  scheduler.absolute=null;
  if(adjustmentMounted.current){setQueuedSteps(0);setPendingAbsolute(false);}
}
function startAdjustmentBatch(batch){
  const scheduler=adjustmentScheduler.current;
  scheduler.active=batch;
  setAdjustmentPending(true);
  Promise.resolve().then(()=>{
    const current=adjustmentLive.current;
    if(!adjustmentMounted.current||batch.context!==current.context)return;
    if(batch.kind==='absolute')return current.canWriteAbsolute?batch.writer(batch.value):undefined;
    if(!current.canAdjust)return;
    return batch.writer(true,{steps:Math.abs(batch.steps)});
  }).catch(()=>{}).finally(()=>{
    if(scheduler.active!==batch)return;
    scheduler.active=null;
    if(adjustmentMounted.current){setAdjustmentPending(false);flushAdjustments();}
  });
}
function flushAdjustments(){
  const scheduler=adjustmentScheduler.current,current=adjustmentLive.current;
  if(!adjustmentMounted.current||scheduler.active)return;
  if(scheduler.absolute){
    const absolute=scheduler.absolute;
    if(absolute.context!==current.context||!current.canWriteAbsolute){cancelUnsentAdjustments();return;}
    if(!absolute.ready)return;
    scheduler.absolute=null;
    setPendingAbsolute(false);
    startAdjustmentBatch(absolute);
    return;
  }
  const queued=scheduler.relative;
  if(!queued.ready||queued.steps===0)return;
  if(queued.context!==current.context||!current.canAdjust){cancelUnsentAdjustments();return;}
  const writer=queued.steps<0?current.decreaseWriter:current.increaseWriter;
  const capability=queued.steps<0?current.decreaseCapability:current.increaseCapability;
  const steps=queued.steps;
  scheduler.relative={steps:0,timer:null,ready:false,context:null};
  setQueuedSteps(0);
  if(capability?.setable!==true)return;
  startAdjustmentBatch({kind:'relative',context:current.context,steps,writer,baseValue:current.value,step:current.step,units:current.units});
}
function estimatedTarget(current,queued){
  const scheduler=adjustmentScheduler.current;
  const pendingAbsolute=scheduler.absolute;
  const active=scheduler.active;
  let base=current.value;
  if(active?.context===current.context)base=active.kind==='absolute'?active.value:active.baseValue+active.steps*active.step;
  if(pendingAbsolute?.context===current.context)base=pendingAbsolute.value;
  return base+queued*current.step;
}
function pressAdjustment(event,direction,disabled){
  event.stopPropagation();
  const current=adjustmentLive.current,scheduler=adjustmentScheduler.current;
  if(disabled||!adjustmentMounted.current||!current.canAdjust)return;
  const capability=direction<0?current.decreaseCapability:current.increaseCapability;
  if(capability?.setable!==true)return;
  const queued=scheduler.relative;
  if(queued.context!=null&&queued.context!==current.context)cancelUnsentAdjustments();
  const pending=scheduler.relative;
  const next=pending.steps+direction;
  if(Math.abs(next)>20)return;
  const estimate=estimatedTarget(current,next);
  if(Math.abs(next)>Math.abs(pending.steps)&&((Number.isFinite(current.min)&&estimate<current.min-1e-7)||(Number.isFinite(current.max)&&estimate>current.max+1e-7)))return;
  clearTimeout(pending.timer);
  pending.steps=next;
  pending.context=current.context;
  pending.ready=false;
  pending.timer=next===0?null:setTimeout(()=>{
    if(scheduler.relative!==pending||!adjustmentMounted.current)return;
    pending.timer=null;
    pending.ready=true;
    flushAdjustments();
  },600);
  setQueuedSteps(next);
}
function queueAbsolute(value){
  const current=adjustmentLive.current,scheduler=adjustmentScheduler.current;
  cancelUnsentAdjustments();
  if(!adjustmentMounted.current||!current.canWriteAbsolute)return;
  const absolute={kind:'absolute',context:current.context,value,writer:u,ready:false,timer:null,step:current.step,units:current.units};
  scheduler.absolute=absolute;
  setPendingAbsolute(true);
  absolute.timer=setTimeout(()=>{
    if(scheduler.absolute!==absolute||!adjustmentMounted.current)return;
    absolute.timer=null;
    absolute.ready=true;
    flushAdjustments();
  },1000);
}
const onLennoxAbsolute=(0,P.useMemo)(()=>queueAbsolute,[u]);
(0,P.useEffect)(()=>{
  adjustmentMounted.current=true;
  return()=>{adjustmentMounted.current=false;cancelUnsentAdjustments();};
},[]);
(0,P.useEffect)(()=>{
  const scheduler=adjustmentScheduler.current;
  if((scheduler.relative.context!=null&&scheduler.relative.context!==adjustmentContext)||(scheduler.absolute&&scheduler.absolute.context!==adjustmentContext)||!canWriteAbsolute)cancelUnsentAdjustments();
},[adjustmentContext,canWriteAbsolute]);
function changeAdjustmentSelection(value){cancelUnsentAdjustments();i(value);}
const pendingEstimate=estimatedTarget(adjustmentLive.current,queuedSteps);
const cannotAdjust=!canAdjust;
const decreaseDisabled=cannotAdjust||decreaseCapability?.setable!==true||queuedSteps<=-20||(Number.isFinite(d?.min)&&pendingEstimate<=d.min);
const increaseDisabled=cannotAdjust||increaseCapability?.setable!==true||queuedSteps>=20||(Number.isFinite(d?.max)&&pendingEstimate>=d.max);
function formatAdjustment(steps,step,units){return(steps>0?'+':'−')+(Math.abs(steps)*step).toFixed(1).replace(/\.0$/,'')+units;}
const activeAdjustment=adjustmentScheduler.current.active;
const applyingText=isAdjustmentPending&&activeAdjustment?(activeAdjustment.kind==='absolute'?'Applying dial change…':'Applying '+formatAdjustment(activeAdjustment.steps,activeAdjustment.step,activeAdjustment.units)+'…'):'';
const queuedText=queuedSteps?'Queued '+formatAdjustment(queuedSteps,displayStep,d?.units??'')+(isAdjustmentPending||hasPendingAbsolute?' after current change':' — sends after pause'):hasPendingAbsolute?'Dial change waits for a pause':'';
const adjustmentStatus=[applyingText,queuedText].filter(Boolean).join(' · ');
`;
  let source = AFTER.slice(0, start) + scheduler + AFTER.slice(end);
  source = replaceReviewed(source, 'max-height:calc(100% - 48px)', 'max-height:calc(100% - 72px)');
  source = replaceReviewed(source, 'onClick:event=>pressAdjustment(event,writer,disabled)', 'onClick:event=>pressAdjustment(event,direction,disabled)');
  source = replaceReviewed(source, 'modeValue:m,onTargetValueChange:h}', 'modeValue:m,onTargetValueChange:lennoxDevice?onLennoxAbsolute:h}');
  source = replaceReviewed(source, 'onSelectionChange:i})}),action]', 'onSelectionChange:lennoxDevice?changeAdjustmentSelection:i})}),action]');
  const footer = "(0,L.jsxs)('div',{role:'group','aria-label':'Temperature adjustment','aria-busy':isAdjustmentPending,style:{display:'flex',alignItems:'center',justifyContent:'center',gap:12,flex:'0 0 48px',height:48,width:'100%',paddingBottom:4,boxSizing:'border-box'},children:[adjustmentButton(-1,decreaseWriter,decreaseDisabled),adjustmentButton(1,increaseWriter,increaseDisabled)]})";
  const coalescedFooter = "(0,L.jsxs)('div',{role:'group','aria-label':'Temperature adjustment',style:{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',flex:'0 0 72px',height:72,width:'100%',boxSizing:'border-box'},children:[(0,L.jsxs)('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',gap:12,height:48},children:[adjustmentButton(-1,decreaseWriter,decreaseDisabled),adjustmentButton(1,increaseWriter,increaseDisabled)]}),(0,L.jsx)('div',{role:'status','aria-live':'polite',style:{fontSize:12,lineHeight:'20px',minHeight:20,textAlign:'center',opacity:0.8},children:adjustmentStatus})]})";
  return replaceReviewed(source, footer, coalescedFooter);
}
const COALESCED_AFTER = buildCoalescedRenderer();
function buildCoalescedHook() {
  const before='(lennoxDeviceInstance?.manager?.setCapabilityValue?.({deviceId:lennoxDeviceInstance.id,capabilityId:o.id,value:e,$timeout:lennoxRequestTimeout})??Promise.reject(Error(`Device manager not available`)))';
  const relative='[`heat_decrease`,`heat_increase`,`cool_decrease`,`cool_increase`,`target_decrease`,`target_increase`].includes(o.id)';
  const after='(('+relative+'&&t?.steps!==void 0&&(!Number.isSafeInteger(t.steps)||t.steps<1||t.steps>20))?Promise.reject(Error(`Adjustment steps must be a whole number from 1 to 20`)):(lennoxDeviceInstance?.manager?.setCapabilityValue?.({deviceId:lennoxDeviceInstance.id,capabilityId:o.id,value:e,...('+relative+'&&t?.steps!==void 0?{opts:{steps:t.steps}}:{}),$timeout:lennoxRequestTimeout})??Promise.reject(Error(`Device manager not available`))))';
  return replaceReviewed(HOOK_AFTER,before,after);
}
const COALESCED_HOOK_AFTER=buildCoalescedHook();
function transformCoalescedSource(source) {
  if(typeof source!=='string')throw Error('Expected JavaScript source text');
  source=replaceReviewed(source,AFTER,COALESCED_AFTER);
  return replaceReviewed(source,HOOK_AFTER,COALESCED_HOOK_AFTER);
}
function patchCoalescedBundle(input) {
  if(!Buffer.isBuffer(input)||sha256(input)!==COALESCED_EXPECTED_SHA256)throw Error('Unsupported Homey bundle; the exact reviewed controls layer is required');
  const output=Buffer.from(transformCoalescedSource(input.toString('utf8')));
  const checked=spawnSync(process.execPath,['--check','--input-type=module'],{input:output,encoding:'utf8',maxBuffer:1024*1024});
  if(checked.error)throw checked.error;
  if(checked.status!==0)throw Error(`Patched JavaScript failed syntax validation: ${checked.stderr.trim()}`);
  return{output,report:{homeyVersion:'13.5.3',originalSha256:sha256(input),patchedSha256:sha256(output),replacements:2,driverId:DRIVER_ID}};
}
function writeCoalescedBundle(inputPath,outputPath) {
  if(!inputPath||!outputPath||path.resolve(inputPath)===path.resolve(outputPath))throw Error('Expected separate input and output paths');
  if(fs.existsSync(outputPath))throw Error('Output already exists');
  const {output,report}=patchCoalescedBundle(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath,output,{flag:'wx',mode:0o644});
  return report;
}

const PREVIEW_EXPECTED_SHA256='e1e089da43b87ed1af663ff59f1017aeddd38b70ae30287a33748cb12075a57c';
function buildPreviewRenderer(){
  let source=replaceReviewed(COALESCED_AFTER,'max-height:calc(100% - 72px)','max-height:calc(100% - 48px)');
  source=replaceReviewed(source,'let{device:t}=WN','let{device:t,deviceInstance:lennoxPreviewDeviceInstance}=WN');
  source=replaceReviewed(source,'const adjustmentLive=(0,P.useRef)(null);',`const adjustmentLive=(0,P.useRef)(null);
const previewObserved=(0,P.useRef)({context:null,value:l});
const [,refreshPreview]=(0,P.useState)(0);`);
  source=replaceReviewed(source,'const canAdjust=showAdjustments&&canWriteAbsolute;',`const canAdjust=showAdjustments&&canWriteAbsolute;
if(previewObserved.current.context!==adjustmentContext){
  const value=Number.isFinite(o?.value)?o.value:l;
  previewObserved.current={context:adjustmentContext,value,metadataValue:o?.value};
}else if(Number.isFinite(o?.value)&&o.value!==previewObserved.current.metadataValue){
  previewObserved.current.value=o.value;
  previewObserved.current.metadataValue=o.value;
  const active=adjustmentScheduler.current.active;
  if(active?.context===adjustmentContext&&o.value!==active.baseValue){active.actualObserved=true;active.observedValue=o.value;}
  clearPreviewBridge();
}`);
  source=replaceReviewed(source,'value:l,min:d?.min,max:d?.max,step:displayStep','value:previewObserved.current.value,min:d?.min,max:d?.max,step:displayStep');
  const helpers=String.raw`function clearPreviewBridge(){
  const scheduler=adjustmentScheduler.current;
  if(scheduler.bridge)clearTimeout(scheduler.bridge.timer);
  scheduler.bridge=null;
}
function previewBase(current){
  const bridge=adjustmentScheduler.current.bridge;
  return bridge?.context===current.context?bridge.value:current.value;
}
function completePreview(batch){
  clearPreviewBridge();
  const current=adjustmentLive.current;
  if(batch.context!==current.context||batch.actualObserved||!batch.sent||batch.failed)return;
  const expected=batch.kind==='absolute'?batch.value:batch.baseValue+batch.steps*batch.step;
  if(!Number.isFinite(expected))return;
  const bridge={context:batch.context,value:expected,timer:null};
  adjustmentScheduler.current.bridge=bridge;
  bridge.timer=setTimeout(()=>{
    if(adjustmentScheduler.current.bridge!==bridge)return;
    adjustmentScheduler.current.bridge=null;
    if(adjustmentMounted.current)refreshPreview(value=>value+1);
  },1500);
}
(0,P.useEffect)(()=>{
  if(!lennoxDevice||o?.id==null||!lennoxPreviewDeviceInstance?.makeCapabilityInstance)return;
  const context=adjustmentContext;
  const instance=lennoxPreviewDeviceInstance.makeCapabilityInstance(o.id,value=>{
    if(!adjustmentMounted.current||adjustmentLive.current.context!==context||!Number.isFinite(value))return;
    previewObserved.current={...previewObserved.current,context,value};
    adjustmentLive.current.value=value;
    const active=adjustmentScheduler.current.active;
    if(active?.context===context&&value!==active.baseValue){active.actualObserved=true;active.observedValue=value;}
    clearPreviewBridge();
    refreshPreview(revision=>revision+1);
  });
  return()=>instance?.destroy();
},[lennoxDevice,lennoxPreviewDeviceInstance,o?.id,adjustmentContext]);
`;
  source=replaceReviewed(source,'function cancelUnsentAdjustments(){',helpers+'function cancelUnsentAdjustments(){\n  clearPreviewBridge();');
  const start=source.indexOf('function startAdjustmentBatch('),end=source.indexOf('function flushAdjustments(',start);
  if(start<0||end<start)throw Error('The reviewed batch scheduler changed');
  const batch=String.raw`function startAdjustmentBatch(batch){
  const scheduler=adjustmentScheduler.current;
  if(!Number.isFinite(batch.baseValue))batch.baseValue=previewBase(adjustmentLive.current);
  scheduler.active=batch;
  setAdjustmentPending(true);
  Promise.resolve().then(()=>{
    const current=adjustmentLive.current;
    if(!adjustmentMounted.current||batch.context!==current.context)return;
    if(batch.kind==='absolute'){
      if(!current.canWriteAbsolute)return;
      batch.sent=true;
      return batch.writer(batch.value);
    }
    if(!current.canAdjust)return;
    batch.sent=true;
    return batch.writer(true,{steps:Math.abs(batch.steps)});
  }).catch(()=>{batch.failed=true;clearPreviewBridge();}).finally(()=>{
    if(scheduler.active!==batch)return;
    if(adjustmentMounted.current&&!batch.failed)completePreview(batch);
    scheduler.active=null;
    if(adjustmentMounted.current){setAdjustmentPending(false);refreshPreview(value=>value+1);flushAdjustments();}
  });
}
`;
  source=source.slice(0,start)+batch+source.slice(end);
  source=replaceReviewed(source,"steps,writer,baseValue:current.value,step:current.step","steps,writer,baseValue:previewBase(current),step:current.step");
  source=replaceReviewed(source,'let base=current.value;\n  if(active?.context===current.context)base=active.kind===\'absolute\'?active.value:active.baseValue+active.steps*active.step;',"let base=previewBase(current);\n  if(active?.context===current.context)base=active.actualObserved?active.observedValue:active.kind==='absolute'?active.value:active.baseValue+active.steps*active.step;");
  source=replaceReviewed(source,'const pendingEstimate=estimatedTarget(adjustmentLive.current,queuedSteps);',`const pendingEstimate=estimatedTarget(adjustmentLive.current,queuedSteps);
const previewMinimum=Number.isFinite(d?.min)?d.min:-Infinity;
const previewMaximum=Number.isFinite(d?.max)?d.max:Infinity;
const optimisticTarget=Number.isFinite(pendingEstimate)&&previewMinimum<=previewMaximum?Math.max(previewMinimum,Math.min(previewMaximum,pendingEstimate)):l;`);
  source=replaceReviewed(source,'units:d?.units??null,targetValue:l,targetValueDecimals:','units:d?.units??null,targetValue:lennoxDevice&&canAdjust?optimisticTarget:l,targetValueDecimals:');
  source=replaceReviewed(source,"flex:'0 0 72px',height:72,width:'100%'","flex:'0 0 48px',height:48,width:'100%'");
  source=replaceReviewed(source,"(0,L.jsx)('div',{role:'status','aria-live':'polite',style:{fontSize:12,lineHeight:'20px',minHeight:20,textAlign:'center',opacity:0.8},children:adjustmentStatus})",'null');
  source=replaceReviewed(source,"role:'group','aria-label':'Temperature adjustment',style:","role:'group','aria-label':'Temperature adjustment','aria-busy':isAdjustmentPending||queuedSteps!==0||hasPendingAbsolute,style:");
  return source;
}
const PREVIEW_AFTER=buildPreviewRenderer();
const PREVIEW_HOOK_AFTER=replaceReviewed(COALESCED_HOOK_AFTER,'let i=o.getable===!0;', 'let i=o.getable===!0&&!(lennoxRequestTimeout===45000&&lennoxDeviceSnapshot?.driverId===`homey:app:com.metalcated.lennox:thermostat`&&[`target_temperature`,`target_temperature.heat`,`target_temperature.cool`].includes(o.id));');

function transformPreviewSource(source){
  if(typeof source!=='string')throw Error('Expected JavaScript source text');
  source=replaceReviewed(source,COALESCED_AFTER,PREVIEW_AFTER);
  return replaceReviewed(source,COALESCED_HOOK_AFTER,PREVIEW_HOOK_AFTER);
}
function patchPreviewBundle(input){
  if(!Buffer.isBuffer(input)||sha256(input)!==PREVIEW_EXPECTED_SHA256)throw Error('Unsupported Homey bundle; the exact reviewed coalescing layer is required');
  const output=Buffer.from(transformPreviewSource(input.toString('utf8')));
  const checked=spawnSync(process.execPath,['--check','--input-type=module'],{input:output,encoding:'utf8',maxBuffer:1024*1024});
  if(checked.error)throw checked.error;
  if(checked.status!==0)throw Error(`Patched JavaScript failed syntax validation: ${checked.stderr.trim()}`);
  return{output,report:{homeyVersion:'13.5.3',originalSha256:sha256(input),patchedSha256:sha256(output),replacements:2,driverId:DRIVER_ID}};
}
function writePreviewBundle(inputPath,outputPath){
  if(!inputPath||!outputPath||path.resolve(inputPath)===path.resolve(outputPath))throw Error('Expected separate input and output paths');
  if(fs.existsSync(outputPath))throw Error('Output already exists');
  const{output,report}=patchPreviewBundle(fs.readFileSync(inputPath));
  fs.writeFileSync(outputPath,output,{flag:'wx',mode:0o644});
  return report;
}

if (require.main === module) {
  try {
    const mode=['--coalesce','--preview'].includes(process.argv[2])?process.argv[2]:null;
    const args=process.argv.slice(mode?3:2);
    if(args.length!==2)throw Error('Usage: node patch-homey-13.5.3-thermostat-buttons.cjs [--coalesce|--preview] REVIEWED.js OUTPUT.js');
    const writer=mode==='--preview'?writePreviewBundle:mode==='--coalesce'?writeCoalescedBundle:writePatchedBundle;
    process.stdout.write(JSON.stringify(writer(...args),null,2)+'\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}

module.exports = { PREVIEW_EXPECTED_SHA256, PREVIEW_AFTER, PREVIEW_HOOK_AFTER, transformPreviewSource, patchPreviewBundle, writePreviewBundle, COALESCED_EXPECTED_SHA256, COALESCED_AFTER, COALESCED_HOOK_AFTER, transformCoalescedSource, patchCoalescedBundle, writeCoalescedBundle, EXPECTED_SHA256, DRIVER_ID, BEFORE, AFTER, HOOK_BEFORE, HOOK_AFTER, transformSource, patchBundle, writePatchedBundle };
